---
description: "No code comments — delete the comment and carry its meaning in names, types and structure"
condition:
  - '(?:^|[\s;{}(\[,])//(?!/? ?<reference|(?:export|line) |lint:|[ \t]*(?:@ts-|@jsx|@(?:jest|vitest)-environment\b|biome-ignore|eslint-|oxlint-|deno-lint-|prettier-|istanbul ignore|c8 ignore|#(?:end)?region\b|go:|nolint\b|\+build\b))'
  - '(?:^|[\s(\[{,;=])/\*(?!!|[\s*]*(?:@license\b|@preserve\b|@jsx|@(?:jest|vitest)-environment\b|biome-ignore|eslint-|oxlint-|deno-lint-|prettier-|@ts-|[#@]__(?:PURE|NO_SIDE_EFFECTS)__|webpack[A-Z]|@vite-ignore|istanbul ignore|c8 ignore|#(?:include|cgo)\b))'
  - '(?:^|\s)#[ \t](?![ \t]*(?:(?:end)?region\b|type:|noqa\b|pragma\b|pylint:|fmt:|mypy:|ruff:|pyright:|isort:|nosec\b|-\*-))'
scope: "tool:edit(*.ts), tool:edit(*.tsx), tool:edit(*.js), tool:edit(*.jsx), tool:edit(*.rs), tool:edit(*.go), tool:edit(*.py), tool:write(*.ts), tool:write(*.tsx), tool:write(*.js), tool:write(*.jsx), tool:write(*.rs), tool:write(*.go), tool:write(*.py)"
interruptMode: always
---

You wrote a code comment. Delete it. This project does not keep comments in source: a comment is a second copy of the code's meaning that nothing checks, so it drifts until it lies.

Put the meaning where the compiler and the reader both see it:

- **Names.** A comment explaining a variable, function or branch is a name you have not written yet. Rename it.
- **Types.** A comment stating a unit, a range, a nullability or an invariant is a type. Encode it (`Milliseconds`, a union, a branded id, `Result`, `Option`).
- **Structure.** A comment labelling a block (`// validate input`) is a function. Extract it and name it after what the comment said.
- **Tests.** A comment describing expected behaviour or an edge case is a test. Write the test instead.

## Bad

```typescript
// retry up to 3 times, waiting 500ms between attempts
for (let i = 0; i < 3; i++) {
	/* the server sometimes drops the first request */
	if (await send(req)) break;
	await sleep(500);
}
```

## Good

```typescript
const MAX_SEND_ATTEMPTS = 3;
const RETRY_DELAY_MS = 500;

async function sendWithRetry(req: Request): Promise<boolean> {
	for (let attempt = 0; attempt < MAX_SEND_ATTEMPTS; attempt++) {
		if (await send(req)) return true;
		await sleep(RETRY_DELAY_MS);
	}
	return false;
}
```

## Still allowed

Tool directives are instructions to a tool, not prose, and stay: `@ts-…`, `@jsx…`, `@vitest-environment` / `@jest-environment`, `biome-ignore`, `eslint-…`, `oxlint-…`, `deno-lint-…`, `prettier-…`, `istanbul ignore` / `c8 ignore`, `// #region` / `// #endregion`, `/// <reference …>`, `/* @vite-ignore */`, `/*#__PURE__*/` / `/*#__NO_SIDE_EFFECTS__*/`, Go's `//go:…`, `//export`, `//line`, `//lint:`, `//nolint`, `// +build` and the cgo `/* #include … */` preamble, Python's `# type:`, `# noqa`, `# pragma`, `# isort:`, `# nosec` and the `# -*- coding -*-` cookie. License headers (`/** @license … */`, including the multi-line form, and `/*! … */`) and shebangs stay too.

When you rewrite a whole file, remove the comments already in it along with yours.
