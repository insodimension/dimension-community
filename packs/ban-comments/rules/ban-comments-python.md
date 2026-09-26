---
description: "No Python comments — delete the comment and carry its meaning in names, type hints and structure"
condition: '(?:^|\s)#(?!!)(?![ \t]*(?:(?:end)?region\b|type:|noqa\b|pragma\b|pylint:|fmt:|mypy:|ruff:|pyright:|isort:|nosec\b|-\*-))'
scope: "tool:edit(*.py), tool:write(*.py)"
interruptMode: always
---

You wrote a code comment. Delete it. This project does not keep comments in source: a comment is a second copy of the code's meaning that nothing checks, so it drifts until it lies.

Put the meaning where the interpreter, the type checker and the reader all see it:

- **Names.** A comment explaining a variable, function or branch is a name you have not written yet. Rename it.
- **Type hints.** A comment stating a unit, a range, an optional value or an invariant is a type. Encode it (`NewType`, `Literal`, `Optional`, a dataclass, an `Enum`).
- **Structure.** A comment labelling a block (`# validate input`) is a function. Extract it and name it after what the comment said.
- **Tests.** A comment describing expected behaviour or an edge case is a test. Write the test instead.

## Bad

```python
# retry up to 3 times, waiting 0.5s between attempts
for i in range(3):
    if send(req):  # the server sometimes drops the first request
        break
    time.sleep(0.5)
```

## Good

```python
MAX_SEND_ATTEMPTS = 3
RETRY_DELAY_SECONDS = 0.5


def send_with_retry(req: Request) -> bool:
    for _attempt in range(MAX_SEND_ATTEMPTS):
        if send(req):
            return True
        time.sleep(RETRY_DELAY_SECONDS)
    return False
```

## Still allowed

Tool directives are instructions to a tool, not prose, and stay: `# type: …`, `# noqa`, `# pragma …`, `# pylint: …`, `# fmt: …`, `# mypy: …`, `# ruff: …`, `# pyright: …`, `# isort: …`, `# nosec`, `# region` / `# endregion`, and the `# -*- coding: … -*-` cookie. Shebangs (`#!/usr/bin/env python`) stay too.

When you rewrite a whole file, remove the comments already in it along with yours.
