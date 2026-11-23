from __future__ import annotations

import argparse
import io
import json
import os
import queue
import shutil
import struct
import sys
import threading
import urllib.request
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, BinaryIO, Callable, Iterator

FRAME_JSON = 1
FRAME_AUDIO = 2
PROGRESS_INTERVAL_SECONDS = 1.0
FISH_CONTEXT_TOKENS = 4096
BREEZE_MAX_NEW_TOKENS = 1500
BREEZE_MAX_SEQ_LEN = 2048
BREEZE_REPETITION_PENALTY = 1.1
BREEZE_PLAIN_CFG = 1.0
BREEZE_DIRECTED_CFG = 4.0
VOXCPM_CFG = 2.0
VOXCPM_TIMESTEPS = 10
CHATTERBOX_EXAGGERATION = 0.5
CHATTERBOX_CFG_WEIGHT = 0.5
DEFAULT_SEED = 42


class Channel:
    def __init__(self, sink: BinaryIO) -> None:
        self._sink = sink
        self._lock = threading.Lock()

    def event(self, **fields: Any) -> None:
        payload = json.dumps(fields).encode("utf-8")
        with self._lock:
            self._sink.write(struct.pack("<IB", len(payload), FRAME_JSON))
            self._sink.write(payload)
            self._sink.flush()

    def audio(self, request_id: int, pcm16: bytes) -> None:
        with self._lock:
            self._sink.write(struct.pack("<IBI", len(pcm16) + 4, FRAME_AUDIO, request_id))
            self._sink.write(pcm16)
            self._sink.flush()


def claim_protocol_stdout() -> BinaryIO:
    protocol = os.fdopen(os.dup(sys.stdout.fileno()), "wb")
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    sys.stdout = sys.stderr
    return protocol


@dataclass(frozen=True)
class Voice:
    audio: str
    transcript: str

    @property
    def key(self) -> tuple[str, float, str]:
        return (self.audio, os.path.getmtime(self.audio), self.transcript)


@dataclass(frozen=True)
class Weights:
    repo: str
    revision: str
    files: list[str] | None


@dataclass(frozen=True)
class Spec:
    id: str
    sample_rate: int
    weights: Weights
    source: dict[str, str] | None


def load_spec(models_file: Path, model_id: str) -> Spec:
    registry = json.loads(models_file.read_text(encoding="utf-8"))
    for entry in registry["models"]:
        if entry["id"] == model_id:
            pin = entry["weights"]
            weights = Weights(pin["repo"], pin["revision"], pin.get("files"))
            return Spec(entry["id"], entry["sampleRate"], weights, entry.get("source"))
    raise SystemExit(f"unknown model {model_id}")


def source_dir(data: Path, spec: Spec) -> Path | None:
    if spec.source is None:
        return None
    return data / "sources" / f"{spec.id}-{spec.source['sha']}"


def weights_dir(weights: Weights) -> str:
    from huggingface_hub import snapshot_download

    return snapshot_download(
        weights.repo, revision=weights.revision, allow_patterns=weights.files, local_files_only=True
    )


def require_cuda() -> str:
    import torch

    if not torch.cuda.is_available():
        raise RuntimeError("voice cloning needs an NVIDIA GPU with CUDA; torch sees none on this machine")
    return "cuda"


def seed_everything(seed: int) -> None:
    import random

    import numpy
    import torch

    random.seed(seed)
    numpy.random.seed(seed)
    torch.manual_seed(seed)
    torch.cuda.manual_seed_all(seed)


def option_float(options: dict[str, Any], name: str, fallback: float) -> float:
    value = options.get(name)
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else fallback


def option_text(options: dict[str, Any], name: str) -> str | None:
    value = options.get(name)
    return value.strip() if isinstance(value, str) and value.strip() else None


class Model:
    sample_rate: int

    def speak(self, text: str, voice: Voice, options: dict[str, Any]) -> Iterator[Any]:
        raise NotImplementedError


class QwenModel(Model):
    def __init__(self, spec: Spec, device: str) -> None:
        import torch
        from qwen_tts import Qwen3TTSModel

        self.sample_rate = spec.sample_rate
        self._model = Qwen3TTSModel.from_pretrained(
            weights_dir(spec.weights), device_map=device, dtype=torch.bfloat16, attn_implementation="sdpa"
        )
        self._prompts: dict[tuple[str, float, str], Any] = {}

    def _prompt(self, voice: Voice) -> Any:
        if voice.key not in self._prompts:
            self._prompts[voice.key] = self._model.create_voice_clone_prompt(ref_audio=voice.audio, ref_text=voice.transcript)
        return self._prompts[voice.key]

    def speak(self, text: str, voice: Voice, options: dict[str, Any]) -> Iterator[Any]:
        wavs, rate = self._model.generate_voice_clone(text=text, voice_clone_prompt=self._prompt(voice))
        if rate != self.sample_rate:
            raise RuntimeError(f"Qwen3-TTS returned {rate} Hz audio, expected {self.sample_rate} Hz")
        yield wavs[0]


class VoxCpmModel(Model):
    def __init__(self, spec: Spec, device: str) -> None:
        from voxcpm import VoxCPM

        self._model = VoxCPM.from_pretrained(
            weights_dir(spec.weights), load_denoiser=False, optimize=False, device=device, local_files_only=True
        )
        self.sample_rate = int(self._model.tts_model.sample_rate)

    def speak(self, text: str, voice: Voice, options: dict[str, Any]) -> Iterator[Any]:
        yield self._model.generate(
            text=text,
            prompt_wav_path=voice.audio,
            prompt_text=voice.transcript,
            reference_wav_path=voice.audio,
            cfg_value=option_float(options, "cfgScale", VOXCPM_CFG),
            inference_timesteps=VOXCPM_TIMESTEPS,
        )


class ChatterboxModel(Model):
    def __init__(self, spec: Spec, device: str) -> None:
        from chatterbox.tts import ChatterboxTTS

        self._model = ChatterboxTTS.from_local(weights_dir(spec.weights), device)
        self.sample_rate = int(self._model.sr)

    def speak(self, text: str, voice: Voice, options: dict[str, Any]) -> Iterator[Any]:
        wav = self._model.generate(
            text,
            audio_prompt_path=voice.audio,
            exaggeration=option_float(options, "exaggeration", CHATTERBOX_EXAGGERATION),
            cfg_weight=option_float(options, "cfgWeight", CHATTERBOX_CFG_WEIGHT),
        )
        yield wav[0].cpu().numpy()


class BreezeModel(Model):
    def __init__(self, spec: Spec, source: Path) -> None:
        sys.path.insert(0, str(source))
        from breeze_infer.runtime import load_runtime, resolve_device, update_generation_config_for_breeze
        from models.fast_streaming import FastBreezeStreamingRuntime, FastStreamingConfig

        self._tokenizer, self._model, self._audio_tokenizer = load_runtime(
            Path(weights_dir(spec.weights)), device=resolve_device(), attn_implementation="eager"
        )
        update_generation_config_for_breeze(self._model)
        config = FastStreamingConfig(
            max_new_tokens=BREEZE_MAX_NEW_TOKENS,
            max_seq_len=BREEZE_MAX_SEQ_LEN,
            fast_all=False,
            repetition_penalty=BREEZE_REPETITION_PENALTY,
        )
        self._runtime = FastBreezeStreamingRuntime(self._model, self._audio_tokenizer, config, tokenizer=self._tokenizer)
        self.sample_rate = int(self._runtime.sample_rate)
        self._requests = 0

    def speak(self, text: str, voice: Voice, options: dict[str, Any]) -> Iterator[Any]:
        from breeze_infer.templates import get_template, prepare_inputs, select_template_name

        self._requests += 1
        request_id = f"speak-{self._requests}"
        request: dict[str, Any] = {
            "id": request_id,
            "text": text,
            "speaker": "S0",
            "ref_audio_path": voice.audio,
            "ref_text": voice.transcript,
        }
        instruction = option_text(options, "instruction")
        if instruction:
            request["instruction"] = instruction
        inputs = prepare_inputs(
            self._tokenizer,
            self._audio_tokenizer,
            self._model,
            [request],
            get_template(select_template_name(request)),
            guidance_scale=option_float(options, "cfgScale", BREEZE_DIRECTED_CFG) if instruction else BREEZE_PLAIN_CFG,
            guidance_scale_ref=None,
            guidance_scale_ins=None,
        )
        seed = int(option_float(options, "seed", DEFAULT_SEED))
        for chunk in self._runtime.iter_audio_chunks(inputs, request_id=request_id, seed=seed):
            yield chunk.audio


class FishModel(Model):
    def __init__(self, spec: Spec, device: str, source: Path) -> None:
        sys.path.insert(0, str(source))
        import torch
        from fish_speech.models.text2semantic import inference

        self._inference = inference
        self._device = device
        checkpoint = weights_dir(spec.weights)
        self._model, self._decode_one_token = self._load_backbone(checkpoint, device)
        with torch.device(device):
            self._model.setup_caches(
                max_batch_size=1, max_seq_len=self._model.config.max_seq_len, dtype=next(self._model.parameters()).dtype
            )
        self._codec = inference.load_codec_model(inference.resolve_codec_path(checkpoint), device, torch.bfloat16)
        self.sample_rate = int(self._codec.sample_rate)
        self._prompts: dict[tuple[str, float, str], Any] = {}

    def _load_backbone(self, checkpoint: str, device: str) -> tuple[Any, Callable[..., Any]]:
        import torch
        from torch.nn import init as nn_init

        inference = self._inference
        skipped = ("kaiming_uniform_", "uniform_", "normal_")
        saved_inits = {name: getattr(nn_init, name) for name in skipped}
        saved_init_weights = inference.BaseTransformer._init_weights
        saved_from_pretrained = inference.DualARTransformer.from_pretrained
        saved_dtype = torch.get_default_dtype()

        def short_context(path: str, load_weights: bool = False, **kwargs: Any) -> Any:
            return saved_from_pretrained(path, load_weights=load_weights, max_length=FISH_CONTEXT_TOKENS, **kwargs)

        for name in skipped:
            setattr(nn_init, name, lambda tensor, *args, **kwargs: tensor)
        inference.BaseTransformer._init_weights = lambda self, module: None
        inference.DualARTransformer.from_pretrained = staticmethod(short_context)
        torch.set_default_dtype(torch.bfloat16)
        try:
            model, decode_one_token = inference.init_model(checkpoint, "cpu", torch.bfloat16, compile=False)
        finally:
            torch.set_default_dtype(saved_dtype)
            inference.DualARTransformer.from_pretrained = saved_from_pretrained
            inference.BaseTransformer._init_weights = saved_init_weights
            for name, original in saved_inits.items():
                setattr(nn_init, name, original)
        return model.to(device=device), decode_one_token

    def _prompt(self, voice: Voice) -> Any:
        if voice.key not in self._prompts:
            self._prompts[voice.key] = self._inference.encode_audio(voice.audio, self._codec, self._device).cpu()
        return self._prompts[voice.key]

    def speak(self, text: str, voice: Voice, options: dict[str, Any]) -> Iterator[Any]:
        import torch

        codes: list[Any] = []
        for response in self._inference.generate_long(
            model=self._model,
            device=self._device,
            decode_one_token=self._decode_one_token,
            text=f"<|speaker:0|>{text}",
            prompt_text=[voice.transcript],
            prompt_tokens=[self._prompt(voice)],
        ):
            if response.action == "sample":
                codes.append(response.codes)
            elif response.action == "next":
                break
        if not codes:
            return
        audio = self._inference.decode_to_audio(torch.cat(codes, dim=1).to(self._device), self._codec)
        yield audio.float().cpu().numpy()


def open_model(spec: Spec, data: Path) -> Model:
    device = require_cuda()
    source = source_dir(data, spec)
    if spec.id == "qwen3-tts":
        return QwenModel(spec, device)
    if spec.id == "voxcpm2":
        return VoxCpmModel(spec, device)
    if spec.id == "chatterbox":
        return ChatterboxModel(spec, device)
    if spec.id == "breeze-tts-2" and source is not None:
        return BreezeModel(spec, source)
    if spec.id == "fish-s2-pro" and source is not None:
        return FishModel(spec, device, source)
    raise SystemExit(f"no runtime for model {spec.id}")


def to_pcm16(samples: Any) -> bytes:
    import numpy

    scaled = numpy.clip(numpy.asarray(samples, dtype=numpy.float32).reshape(-1), -1.0, 1.0)
    scaled *= 32767.0
    return scaled.astype("<i2").tobytes()


@dataclass
class Request:
    id: int
    text: str
    voice: Voice
    options: dict[str, Any]


class Inbox:
    def __init__(self) -> None:
        self.requests: queue.Queue[Request | None] = queue.Queue()
        self._cancelled: set[int] = set()
        self._lock = threading.Lock()

    def is_cancelled(self, request_id: int) -> bool:
        with self._lock:
            return request_id in self._cancelled

    def read_forever(self) -> None:
        for line in sys.stdin:
            if not line.strip():
                continue
            command = json.loads(line)
            if command["op"] == "cancel":
                with self._lock:
                    self._cancelled.add(int(command["id"]))
            elif command["op"] == "speak":
                voice = Voice(command["voice"]["audio"], command["voice"]["transcript"])
                self.requests.put(Request(int(command["id"]), command["text"], voice, command.get("options") or {}))
        self.requests.put(None)


def serve(spec: Spec, data: Path, channel: Channel) -> None:
    model = open_model(spec, data)
    channel.event(t="ready", sampleRate=model.sample_rate)
    inbox = Inbox()
    threading.Thread(target=inbox.read_forever, daemon=True).start()
    while (request := inbox.requests.get()) is not None:
        if inbox.is_cancelled(request.id):
            channel.event(t="done", id=request.id)
            continue
        try:
            seed_everything(int(option_float(request.options, "seed", DEFAULT_SEED)))
            for samples in model.speak(request.text, request.voice, request.options):
                if inbox.is_cancelled(request.id):
                    break
                channel.audio(request.id, to_pcm16(samples))
            channel.event(t="done", id=request.id)
        except Exception as error:
            channel.event(t="error", id=request.id, message=f"{type(error).__name__}: {error}")


def fetch_source(data: Path, spec: Spec, channel: Channel) -> None:
    target = source_dir(data, spec)
    if target is None or target.is_dir():
        return
    assert spec.source is not None
    channel.event(t="progress", stage=f"downloading {spec.source['repo']} source", fraction=0.0)
    url = f"https://codeload.github.com/{spec.source['repo']}/zip/{spec.source['sha']}"
    with urllib.request.urlopen(url) as response:
        archive = zipfile.ZipFile(io.BytesIO(response.read()))
    staging = target.with_name(target.name + ".partial")
    shutil.rmtree(staging, ignore_errors=True)
    archive.extractall(staging)
    roots = [entry for entry in staging.iterdir() if entry.is_dir()]
    if len(roots) != 1:
        raise RuntimeError(f"the {spec.source['repo']} archive did not hold one top folder")
    roots[0].rename(target)
    shutil.rmtree(staging, ignore_errors=True)


def cache_bytes(repo: str) -> int:
    from huggingface_hub.constants import HF_HUB_CACHE

    folder = Path(HF_HUB_CACHE) / ("models--" + repo.replace("/", "--")) / "blobs"
    if not folder.is_dir():
        return 0
    return sum(entry.stat().st_size for entry in folder.iterdir() if entry.is_file())


def fetch_weights(spec: Spec, channel: Channel) -> None:
    from huggingface_hub import HfApi, snapshot_download

    weights = spec.weights
    info = HfApi().model_info(weights.repo, revision=weights.revision, files_metadata=True)
    wanted = [
        sibling
        for sibling in info.siblings or []
        if weights.files is None or sibling.rfilename in weights.files
    ]
    total = sum(sibling.size or 0 for sibling in wanted) or 1
    start = cache_bytes(weights.repo)
    finished = threading.Event()

    def report() -> None:
        while not finished.wait(PROGRESS_INTERVAL_SECONDS):
            fraction = min(1.0, (cache_bytes(weights.repo) - start) / total)
            channel.event(t="progress", stage=f"downloading {weights.repo}", fraction=fraction)

    reporter = threading.Thread(target=report, daemon=True)
    reporter.start()
    try:
        snapshot_download(weights.repo, revision=weights.revision, allow_patterns=weights.files)
    finally:
        finished.set()
        reporter.join()
    channel.event(t="progress", stage=f"downloaded {weights.repo}", fraction=1.0)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--models-file", type=Path, required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--setup", action="store_true")
    args = parser.parse_args()
    channel = Channel(claim_protocol_stdout())
    spec = load_spec(args.models_file, args.model)
    try:
        if args.setup:
            fetch_source(args.data, spec, channel)
            fetch_weights(spec, channel)
        else:
            serve(spec, args.data, channel)
    except BaseException as error:
        channel.event(t="fatal", message=f"{type(error).__name__}: {error}")
        raise


if __name__ == "__main__":
    main()
