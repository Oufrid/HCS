"""Refund worker: runs every night and refunds the approved requests."""

from datetime import datetime, timedelta, timezone

REFUND_WINDOW_DAYS = 14
RESTOCKING_FEE_PERCENT = 0


class RefundError(Exception):
    pass


def refundable(order, now=None):
    """An order can be refunded within REFUND_WINDOW_DAYS of delivery, or any time before shipping."""
    now = now or datetime.now(timezone.utc)
    if order["status"] in ("paid",):
        return True
    if order["status"] != "delivered":
        return False
    delivered = datetime.fromisoformat(order["deliveredAt"].replace("Z", "+00:00"))
    return now - delivered <= timedelta(days=REFUND_WINDOW_DAYS)


def refund_amount(order_total):
    """Full amount: there is no restocking fee."""
    return order_total - order_total * RESTOCKING_FEE_PERCENT // 100


def run(requests, gateway, now=None):
    """Refund every approved request; a refused one is logged and skipped, never retried automatically."""
    done = []
    for req in requests:
        if not req.get("approved"):
            continue
        if not refundable(req["order"], now):
            print("refund refused for order %s: outside the window" % req["order"]["id"])
            continue
        gateway.refund(req["order"]["id"], refund_amount(req["total"]))
        done.append(req["order"]["id"])
    return done
