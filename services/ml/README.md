# services/ml

Python (FastAPI) models for v2: **Inbox Guardian** (pre-send spam-placement risk) and
**Win Pattern Miner**. Gradient-boosted models (LightGBM) with LLM-written explanations.

Not part of the MVP. Kept here so the monorepo layout is final from day one.

Rules: trained only on opt-in, anonymised, aggregated signals — never on email content.
