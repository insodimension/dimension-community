import sys
from pathlib import Path

DD = Path(__file__).resolve().parents[1]
if str(DD) not in sys.path:
    sys.path.insert(0, str(DD))
