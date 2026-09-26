"""Runs browser_use.Agent against an existing Chrome; keep_alive leaves the browser and tab open."""

import asyncio
import json
import os


def _label(entry):
    output = entry.model_output
    if output is None:
        # No model output means the step failed (endpoint error, unparseable reply): say why.
        errors = [r.error for r in entry.result if getattr(r, "error", None)]
        return f"no action ({errors[0].splitlines()[0][:160]})" if errors else "no action"
    parts = []
    for action in output.action:
        for name, params in action.model_dump(exclude_unset=True, exclude_none=True).items():
            args = json.dumps(params, ensure_ascii=False) if params else ""
            parts.append(f"{name} {args[:120]}".strip())
    return "; ".join(parts) or (output.next_goal or "no action")


def run(request, cancel, report):
    return asyncio.run(_run(request, cancel, report))


def preload():
    """Imports what a run needs; a pre-spawned worker calls this while it waits for its job."""
    from browser_use import Agent, BrowserSession, ChatGoogle, ChatOpenAI  # noqa: F401


def _llm():
    """browser-use's own chat class for the configured model: gemini-* uses its native Google
    client (GOOGLE_API_KEY); anything else its OpenAI client, any OpenAI-compatible endpoint."""
    model = os.environ.get("DIMENSION_BROWSER_USE_MODEL", "gpt-4.1-mini")
    key = os.environ.get("DIMENSION_BROWSER_USE_API_KEY")
    if model.startswith("gemini"):
        from browser_use import ChatGoogle

        return ChatGoogle(model=model, api_key=key or os.environ.get("GOOGLE_API_KEY"))
    from browser_use import ChatOpenAI

    return ChatOpenAI(
        model=model,
        base_url=os.environ.get("DIMENSION_BROWSER_USE_BASE_URL") or None,
        api_key=key or os.environ.get("OPENAI_API_KEY"),
    )


async def _run(request, cancel, report):
    from browser_use import Agent, BrowserSession

    async def should_stop():
        return cancel.is_set()

    async def update_usage(agent):
        summary = await agent.token_cost_service.get_usage_summary()
        report.usage = {
            "modelCalls": summary.entry_count,
            "inputTokens": summary.total_prompt_tokens,
            "outputTokens": summary.total_completion_tokens,
            "costUsd": None,  # browser-use prices calls only with calculate_cost (fetches a price table)
        }

    async def on_step_end(agent):
        await update_usage(agent)
        entry = agent.history.history[-1]
        report.step(_label(entry), entry.state.url)

    start = request.get("startUrl")
    if start and not start.startswith(("http://", "https://")):
        start = None
    # flash_mode (no per-step thinking/evaluation), no planner and no judge call: measured on the
    # 14-stage practice world with gemini-3.1-flash-lite, 14/14 either way, 558 s and 251k tokens
    # against 726 s and 787k tokens for the library defaults (bench/results, 2026-09-26).
    agent = Agent(
        task=request["task"],
        llm=_llm(),
        browser_session=BrowserSession(cdp_url=request["cdpUrl"], keep_alive=True),
        initial_actions=[{"navigate": {"url": start, "new_tab": False}}] if start else None,
        register_should_stop_callback=should_stop,
        flash_mode=True,
        enable_planning=False,
        use_judge=False,
    )
    history = await agent.run(max_steps=request["maxSteps"], on_step_end=on_step_end)
    await update_usage(agent)
    if history.is_done():
        summary = history.final_result() or ""
        return ("done" if history.is_successful() else "blocked"), summary
    if cancel.is_set():
        return "cancelled", f"Cancelled after {report.steps} steps."
    errors = [e for e in history.errors() if e]
    # The first error is the cause (e.g. the model endpoint refusing); later ones are its echoes.
    return "failed", errors[0] if errors else "browser-use stopped without finishing."
