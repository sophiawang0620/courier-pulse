"""Manual smoke test for a separately running local dashboard."""

import json
import urllib.error
import urllib.request


root = "http://127.0.0.1:8765"
html = urllib.request.urlopen(root + "/", timeout=5).read().decode("utf-8")
assert "只在该提醒时提醒。" in html
assert 'id="add-form"' in html
state = json.loads(urllib.request.urlopen(root + "/api/watchlist", timeout=5).read())
assert isinstance(state.get("shipments"), dict)
request = urllib.request.Request(
    root + "/api/add",
    data=json.dumps({"waybills": ["bad"]}).encode("utf-8"),
    headers={"Content-Type": "application/json"},
    method="POST",
)
try:
    urllib.request.urlopen(request, timeout=5)
except urllib.error.HTTPError as error:
    assert error.code == 400
else:
    raise AssertionError("invalid waybill was accepted")
print("Local dashboard HTTP smoke test passed.")
