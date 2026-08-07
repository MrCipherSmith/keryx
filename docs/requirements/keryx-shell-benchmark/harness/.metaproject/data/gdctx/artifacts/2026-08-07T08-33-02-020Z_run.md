# gdctx command summary

Command: `python3 -c 
import json,glob,os
for m in sorted(glob.glob('/home/altsay/keryx/docs/requirements/keryx-shell-benchmark/evidence/run-2/A*claude*/meta.json')):
    d=json.load(open(m)); n=os.path.basename(os.path.dirname(m))
    print('%-26s %7s auto=%s'%(n, d['wallTimeSeconds'], d.get('autoApproved','ABSENT')))
`
Exit code: `0`
Raw lines: `10`
stdout bytes: `450`
stderr bytes: `0`


## Output

```text
A1-baseline-claude           221.3 auto=True
A1-naked-claude              196.9 auto=True
A12-baseline-claude           72.6 auto=True
A12-naked-claude             116.7 auto=True
A3-baseline-claude           112.8 auto=True
A3-naked-claude              220.9 auto=True
A4-baseline-claude           172.7 auto=True
A4-naked-claude              204.9 auto=True
A5-baseline-claude            84.6 auto=True
A5-naked-claude              120.7 auto=True
```

## Metadata

```json
{
  "id": "2026-08-07T08-33-02-020Z_run",
  "kind": "run",
  "command": "python3 -c \nimport json,glob,os\nfor m in sorted(glob.glob('/home/altsay/keryx/docs/requirements/keryx-shell-benchmark/evidence/run-2/A*claude*/meta.json')):\n    d=json.load(open(m)); n=os.path.basename(os.path.dirname(m))\n    print('%-26s %7s auto=%s'%(n, d['wallTimeSeconds'], d.get('autoApproved','ABSENT')))\n",
  "exitCode": 0,
  "rawPath": ".metaproject/data/gdctx/raw/2026-08-07T08-33-02-020Z_run.log",
  "summaryPath": ".metaproject/data/gdctx/artifacts/2026-08-07T08-33-02-020Z_run.md",
  "bytesIn": 450,
  "bytesOut": 892,
  "truncated": false
}
```
