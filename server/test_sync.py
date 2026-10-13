"""
Ask the running server to sync a video, exactly as the extension does, and
print what came back.

Usage:  python test_sync.py <video url> [--force]
"""
import asyncio
import json
import sys

import websockets

sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def clock(t):
    return f"{int(t // 60)}:{int(t % 60):02d}"


async def main():
    url = sys.argv[1]
    async with websockets.connect("ws://127.0.0.1:8790", max_size=None) as ws:
        await ws.send(json.dumps({"type": "align", "url": url, "force": "--force" in sys.argv}))
        last = None
        async for raw in ws:
            m = json.loads(raw)
            if m["type"] == "align_progress":
                tag = (m["stage"], int(m["pct"] * 10))
                if tag != last:
                    print(f"  … {m['stage']} {m['pct']*100:.0f}%")
                    last = tag
            elif m["type"] == "align_error":
                print("ERROR:", m["error"])
                return
            elif m["type"] == "align_result":
                tl = m["timeline"]
                print(f"\n{tl['title']}  ({clock(tl['duration'])}, precise={tl['precise']})")
                for p in tl["passages"]:
                    print(f"  passage {p['from']} → {p['to']}  ({p['ayahs']} ayahs)  {clock(p['t0'])}–{clock(p['t1'])}")
                for e in tl["ayahs"]:
                    label = "basmala" if e.get("basmala") else e["ref"]
                    print(f"  {clock(e['t0']):>6} {label:>8}  {len(e['w'])}w  {e['arabic'][:48]}")
                return


asyncio.run(main())
