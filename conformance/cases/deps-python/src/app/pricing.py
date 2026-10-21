from .util import round_up, LIMIT
from app.tax import vat as v


def fee(w):
    if w > LIMIT:
        raise ValueError('round_up')
    return round_up(base(w)) + v(w)


def base(w):
    return 25 + w * 4
