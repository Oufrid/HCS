import os


class Cart:
    """A cart."""

    def __init__(self):
        self.items = []

    @property
    def size(self):
        return len(self.items)

    async def total(self):
        return 0


def helper(x):
    def inner():
        return x

    return inner


@decorator
def decorated():
    pass
