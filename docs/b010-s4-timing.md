Each enabled-path function in migration `20261104120300` has three polling attempts lasting approximately two seconds each. The two intervening backoffs are 50 ms and 100 ms:

```text
Per call:             3 × 2000 + 50 + 100 = 6150 ms
Two sequential calls: 2 × 6150            = 12300 ms
```

The budget applies separately to `app.b010_lock_payment_context` and the payment trigger `app.b010_guard_payment_transition`. A transaction can spend nearly one budget acquiring context and then encounter contention in the trigger. Failure in the first call prevents the second call from running; nevertheless, the two-call path must allow their budgets to accumulate.

Session A’s observed 8169 ms and `55P03` are consistent with this design. Its measurement also includes the explicit two-second sleep. Session B’s 6715 ms success and the absence of `40P01` satisfy the intended outcome.

Use **16000 ms** as the shared measured acceptance ceiling in the script and integration test:

```text
Two call budgets                         12300 ms
S4-A intentional sleep                    2000 ms
SQL/setup/scheduling allowance             1700 ms
Acceptance ceiling                       16000 ms
```

The integration test has no intentional sleep inside A’s measured action, but uses the same conservative ceiling. Retain its existing outcome assertions and lower bounds.

For script S4, each session must finish successfully or with `55P03`, neither may report `40P01`, and each SQL elapsed time must be at most 16000 ms. Measure SQL time because HTTPS transport time is outside the database contention budget.

The 12300 ms figure is an approximate polling budget, not a strict transaction deadline. Query execution, scheduler delays, and implicit relation locks can add time. The script’s 17-second statement timeout is an outer safeguard; it does not itself enforce a transaction-wide deadline.
