// Copied from OMP (https://github.com/can1357/oh-my-pi, MIT), packages/coding-agent/src/tools/browser/tab-worker.ts (the WorkerCore fields and methods that belong to one adopted page: #observeDialogs,
// #claimRelayTarget, #clearElementCache, #stopLoading, #close) @ dc5f95d9e1 (Dimension omp fork).
// Copyright (c) 2025 Mario Zechner; (c) 2025-2026 Can Bölük; (c) 2026 Stencil Labs, Inc. See ../../../third-party/omp/LICENSE.
// Changed for the Browser pack (matrix D5, D28): OMP's worker is ONE tab, so its state is WorkerCore's; here one worker holds every tab of a session, so each adopted page is a TabSession.
// The engine answers dialogs (one handler, two CDP clients never both answer), so the session only OBSERVES them, and learns they were answered from CDP's javascriptDialogClosed.

import type { Browser, CDPSession, Page } from "puppeteer-core";
import type { CodeEvaluator, TabHandle } from "../contracts";
import { ElementCache } from "./element-cache";
import { OpRunner, type RunState } from "./tab-ops";

/** Last JS dialog seen on the page; kept for timeout attribution until it is answered or a navigation proves it gone. */
export interface OpenDialogInfo {
  type: string;
  message: string;
}

/** One adopted page: what the engine opened and instrumented, as the worker holds it. */
export class TabSession {
  readonly elements = new ElementCache();
  readonly ops: OpRunner;
  /** The run in flight on this tab, if any. */
  active: RunState | null = null;
  /** Settles when the last run on this tab has finished unwinding (a closing tab waits a grace for it). */
  done: Promise<void> = Promise.resolve();
  /** The evaluator that holds this tab's `tab.run` variables (one per tab when the realm is given a factory). */
  evaluator: CodeEvaluator | undefined;
  openDialog: OpenDialogInfo | undefined;
  #cdp: Promise<CDPSession> | undefined;
  #disposers: Array<() => void> = [];

  constructor(
    readonly name: string,
    readonly handle: TabHandle,
    readonly browser: Browser,
    readonly page: Page,
    readonly activateForScreenshot: boolean,
  ) {
    this.ops = new OpRunner(() => this.page);
    this.#observeDialogs();
  }

  /** One CDP session on the page, shared by layout metrics, `Page.stopLoading` and the dialog-closed event. */
  cdp(): Promise<CDPSession> {
    this.#cdp ??= this.page.createCDPSession();
    return this.#cdp;
  }

  /**
   * Record JS dialogs for timeout attribution without handling them. Cleared when the dialog is answered (by the engine or by the code) or a main-frame navigation
   * proves the modal is gone.
   */
  #observeDialogs(): void {
    const { page } = this;
    const onDialog = (dialog: { type(): string; message(): string }): void => {
      this.openDialog = { type: dialog.type(), message: dialog.message() };
    };
    const onNavigated = (frame: unknown): void => {
      if (frame === page.mainFrame()) this.openDialog = undefined;
    };
    page.on("dialog", onDialog);
    page.on("framenavigated", onNavigated);
    this.#disposers.push(
      () => page.off("dialog", onDialog),
      () => page.off("framenavigated", onNavigated),
    );
    // Page.enable is not awaited: on a page already blocked by a modal it may never answer, and nothing here waits for it.
    void this.cdp()
      .then(session => {
        const onClosed = (): void => {
          this.openDialog = undefined;
        };
        session.on("Page.javascriptDialogClosed", onClosed);
        this.#disposers.push(() => session.off("Page.javascriptDialogClosed", onClosed));
        return session.send("Page.enable");
      })
      .catch(() => undefined);
  }

  /**
   * Tell the omp browser relay this worker drives the adopted page, so the relay adds it to the per-window "omp" tab group. Best-effort: plain CDP
   * backends reject the relay-private method.
   */
  async claimRelayTarget(): Promise<void> {
    let session: CDPSession | undefined;
    try {
      session = await this.page.createCDPSession();
      // Puppeteer's protocol map cannot express the relay-private method; the send signature is otherwise identical.
      const raw = session as unknown as { send(method: string): Promise<unknown> };
      await raw.send("OMP.claimTarget");
    } catch {
      // Not the omp relay; nothing to claim.
    } finally {
      await session?.detach().catch(() => undefined);
    }
  }

  /** Best-effort `Page.stopLoading` so an abandoned navigation cannot stall later ops. */
  async stopLoading(): Promise<void> {
    try {
      await (await this.cdp()).send("Page.stopLoading");
    } catch {
      // The page is gone or the session was dropped: nothing left to stop.
    }
  }

  /** Forget the page: listeners off, handles disposed, the CDP session detached. The page itself is the engine's and stays open. */
  async dispose(): Promise<void> {
    for (const dispose of this.#disposers.splice(0)) dispose();
    this.elements.clear();
    const session = await this.#cdp?.catch(() => undefined);
    this.#cdp = undefined;
    await session?.detach().catch(() => undefined);
  }
}
