"""Makes `python -m dim_browser_bridge` run the FAKE worker next to this file.

The runtime launches the real interpreter with cwd = packs/browser/python, and
for `-m` Python puts the cwd at sys.path[0] AFTER site initialization — so the
real package would win over anything on PYTHONPATH. `site` imports this module
first (it is on PYTHONPATH), and binding the fake package into sys.modules here
is what `runpy` then resolves `dim_browser_bridge.__main__` against.
"""

import dim_browser_bridge  # noqa: F401  (the fake, found via PYTHONPATH)
