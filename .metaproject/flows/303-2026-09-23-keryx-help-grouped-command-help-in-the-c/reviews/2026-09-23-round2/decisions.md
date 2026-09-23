# Decisions

- F-101: acted-on — probe() and mark() each wrapped in their own try/catch in resolveFirstRunHelp; commit 6882b1ce82af478f7230019e4ce5e3ec6c398ddb, PR #669, merged to main as 0b4f4d64b61519486ab8c63e53c30ee572c251c2. (valid_followup, post_flow_feedback).
- F-102: acted-on — openHelp guarded by `!destroyed`, and `.catch` added to the first-run promise chain, logging via debugEvent instead of throwing; commit 6882b1ce82af478f7230019e4ce5e3ec6c398ddb, PR #669, merged to main as 0b4f4d64b61519486ab8c63e53c30ee572c251c2. (valid_followup, post_flow_feedback).
