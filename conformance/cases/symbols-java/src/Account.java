public class Account {
    private int balance;

    public Account(int start) {
        this.balance = start;
    }

    public synchronized void deposit(int amount) {
        if (amount <= 0) {
            throw new IllegalArgumentException("bad");
        }
        balance += amount;
    }
}
