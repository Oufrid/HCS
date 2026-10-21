# Notes for coding agents

- Prices are integers in cents everywhere; see `src/pricing.ts`.
- Order totals are computed in `src/orders.ts`, refunds in `worker/refunds.py`.
- Payments go through the gateway client in `src/payments.ts`.
- The refund window is 30 days.
- Run the tests with `npm test`.
