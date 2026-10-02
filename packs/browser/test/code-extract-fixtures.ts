/** The HTML pages `tab.extract` is checked on. `code-extract-golden.json` holds what OMP's own extractor made of each, in both formats. */
export interface ExtractFixture {
  url: string;
  html: string;
}

export const EXTRACT_FIXTURES: Record<string, ExtractFixture> = {
  // A plain article: Readability isolates it.
  article: {
    url: "https://example.com/docs/responses",
    html: `<!doctype html>
<html>
  <head><title>Docs</title></head>
  <body>
    <header><nav><a href="/">Home</a> <a href="/docs">Docs</a></nav></header>
    <article>
      <h1>Responses API</h1>
      <p>The Responses API stores output only when you opt in. It is a <strong>stateful</strong> interface, so a later call can refer to an earlier one by its <a href="https://example.com/docs/ids">id</a>.</p>
      <p>Use it when a conversation must survive a restart; otherwise the plain chat endpoint is simpler and cheaper to run.</p>
      <h2>1. Opting in</h2>
      <ol>
        <li>Create a response with <code>store: true</code>.</li>
        <li>Keep the returned <em>id</em>.</li>
        <li>Pass it as <code>previous_response_id</code> next time.</li>
      </ol>
      <pre><code class="language-js">const r = await client.responses.create({ store: true });
console.log(r.id);</code></pre>
    </article>
    <footer>Copyright Example Inc.</footer>
  </body>
</html>`,
  },
  // A docs shell: little prose, so Readability gives up and the selector chain finds [data-pagefind-body].
  docs: {
    url: "https://developers.example.com/apps-sdk/reference",
    html: `<!doctype html>
<html>
  <head><title>Reference</title></head>
  <body>
    <div class="app-shell">
      <nav>Navigation</nav>
      <main data-pagefind-body>
        <section>
          <h1>Apps SDK</h1>
          <p>Build once, run in many places.</p>
        </section>
      </main>
    </div>
  </body>
</html>`,
  },
  // GFM: a table, strikethrough, a task list, nested lists, an image, script and style that must not leak.
  gfm: {
    url: "https://example.com/changelog",
    html: `<!doctype html>
<html>
  <head><title>Changelog</title><style>body { color: red }</style></head>
  <body>
    <main>
      <h1>Changelog</h1>
      <p>Everything that changed in the last release, in the order it landed on the main branch of the project.</p>
      <script>window.__tracking = "must not appear";</script>
      <h2>2.0 shipped.</h2>
      <table>
        <thead><tr><th>Area</th><th>Change</th></tr></thead>
        <tbody>
          <tr><td>Browser</td><td>Code tool replaces the step tools</td></tr>
          <tr><td>Profiles</td><td><del>Cookie import</del> removed</td></tr>
        </tbody>
      </table>
      <ul>
        <li>First
          <ul><li>Nested one</li><li>Nested two</li></ul>
        </li>
        <li>Second</li>
      </ul>
      <ol start="3"><li>Third</li><li>Fourth</li></ol>
      <p><img src="/logo.png" alt="Logo"> and a line<br>break.</p>
      <blockquote><p>Quoted text spans a whole sentence so that the extractor keeps it.</p></blockquote>
    </main>
  </body>
</html>`,
  },
  // No article, no <main>: the [role=main] branch.
  roleMain: {
    url: "https://example.com/app",
    html: `<!doctype html>
<html>
  <head><title>App</title></head>
  <body>
    <div role="main"><h2>Dashboard</h2><p>3 open items</p></div>
    <div id="chrome">Sidebar</div>
  </body>
</html>`,
  },
  // Nothing readable at all.
  empty: {
    url: "https://example.com/blank",
    html: "<!doctype html><html><head><title>Blank</title></head><body></body></html>",
  },
};
