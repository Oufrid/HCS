<!-- hcs:transcript -->
# conversation

### [1] user

Support keeps getting refund requests for parcels delivered 20 days ago. Our refund window is 14 days, right? Should we extend it?

### [2] assistant

Yes, worker/refunds.py sets REFUND_WINDOW_DAYS = 14, and docs/policy.md says the same. Extending it means changing both, plus any customer-facing text. Before deciding, it helps to know how many requests fall between 14 and 30 days.

### [3] user

Last month: 41 refund requests, 9 of them between 15 and 30 days after delivery. Let's extend the window to 30 days, but only for orders over 100.00.

### [4] assistant

Decision noted: refund window becomes 30 days for orders whose total is over 100.00 (10000 cents), and stays 14 days otherwise. Plan: 1) add LONG_WINDOW_DAYS = 30 and LONG_WINDOW_FROM = 10000 to worker/refunds.py; 2) make refundable() take the order total into account; 3) update the Refunds section of docs/policy.md; 4) fix AGENTS.md, which wrongly says 30 days for everyone.

### [5] user

Good. Don't touch the restocking fee, it stays at zero. And the change must ship before 1 December.

### [6] assistant

Understood: RESTOCKING_FEE_PERCENT stays 0, and the deadline is 1 December. Open question for next time: should orders paid with SPRING5 count their total before or after the discount when checking the 100.00 threshold?
