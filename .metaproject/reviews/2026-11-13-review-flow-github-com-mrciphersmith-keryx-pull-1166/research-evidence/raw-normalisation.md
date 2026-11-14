# Raw result normalisation (round 2)

These replies declared their status on line 1 (`STATUS: …`) but left it out of the REVIEW_RESULT object, so the ledger parser read them as unusable. The declared status was copied into the object as its first key; no finding, slice or other field was changed.

- raw/review-core-boundaries-w2.txt: added "status": "DONE" (line 1 reads `STATUS: DONE`); findings: 0
- raw/review-highload-w1.txt: added "status": "DONE" (line 1 reads `STATUS: DONE`); findings: 0
- raw/review-logic-w4.txt: added "status": "DONE" (line 1 reads `STATUS: DONE`); findings: 1
- raw/review-regression-w2.txt: added "status": "DONE" (line 1 reads `STATUS: DONE`); findings: 0
- raw/review-security-code-w10.txt: added "status": "DONE" (line 1 reads `STATUS: DONE`); findings: 0
- raw/review-security-code-w2.txt: added "status": "DONE" (line 1 reads `STATUS: DONE`); findings: 0
- raw/review-security-code-w3.txt: added "status": "DONE" (line 1 reads `STATUS: DONE`); findings: 0
- raw/review-security-code-w5.txt: added "status": "DONE" (line 1 reads `STATUS: DONE`); findings: 0
- raw/review-security-code-w6.txt: added "status": "DONE" (line 1 reads `STATUS: DONE`); findings: 0
- raw/review-testing-practices-w1.txt: added "status": "DONE" (line 1 reads `STATUS: DONE`); findings: 1
