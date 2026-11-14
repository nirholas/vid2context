"""Replace email addresses and phone numbers in a fixture's metadata.description
with [email redacted] and [phone redacted], the convention of tests/fixtures.

    python3 -I packages/insights/scripts/redact-fixture.py <fixture.json>...
"""
import json
import re
import sys

EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
PHONE = re.compile(r"\(?\b\d{3}\)?[-. ]\d{3}[-. ]\d{4}\b")

for path in sys.argv[1:]:
    with open(path) as f:
        ctx = json.load(f)
    d = ctx["metadata"].get("description") or ""
    red = PHONE.sub("[phone redacted]", EMAIL.sub("[email redacted]", d))
    ctx["metadata"]["description"] = red
    text = json.dumps(ctx)
    left = EMAIL.findall(text) + PHONE.findall(text)
    with open(path, "w") as f:
        f.write(json.dumps(ctx, indent=2, ensure_ascii=False) + "\n")
    print(path, "description changed" if red != d else "description clean", "| left anywhere:", left)
