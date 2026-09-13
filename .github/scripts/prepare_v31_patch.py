from pathlib import Path
import re

path = Path('.github/scripts/apply_v31_fixes.py')
text = path.read_text()
pattern = r"test_text = replace_once\(\n    test_text,\n.*?    'extend gameplay test imports'\n\)"
replacement = '''test_text = replace_once(
    test_text,
    "  adultDiscoveryPhase,\\n  averageAdultProgress,\\n  computeAdultSelectionDelta,\\n  computeWarmupSelectionDelta,\\n  isOutcomeUnlocked,\\n  normalizeOutcomeUnlockProgress,\\n  pickNextVariant,\\n  positionUnlockProgress\\n",
    "  adultDiscoveryPhase,\\n  averageAdultProgress,\\n  canUnlockBonusPositions,\\n  canUnlockCorePositions,\\n  computeAdultSelectionDelta,\\n  computeWarmupSelectionDelta,\\n  isOutcomeUnlocked,\\n  monotonicAdultPhase,\\n  normalizeOutcomeUnlockProgress,\\n  pickNextVariant,\\n  positionUnlockProgress,\\n  requiredWarmupDiscoveries\\n",
    'extend gameplay test imports'
)'''
updated, count = re.subn(pattern, lambda _match: replacement, text, count=1, flags=re.S)
if count != 1:
    raise RuntimeError(f'expected one test import patch, got {count}')
path.write_text(updated)
print('Prepared v3.1 patch script for current test imports.')
