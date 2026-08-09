// HAND-OWNED. The tests that make this folder mean anything.
//
// Every generated GWT test is SEQUENTIAL — it appends its GIVEN, sends one command, asserts. No GWT can
// express a race, which is why the kit routes contended invariants to `architect.mjs tests` instead.
// These are those tests, written by hand.
//
// TWO SHAPES, and both are needed:
//
//   deterministic  two writers, interleaving controlled by a barrier. Proves the MECHANISM, and cannot
//                  be flaky in either direction.
//   stress         N writers, real timing, no barrier. Proves the mechanism survives contention it did
//                  not stage-manage, and catches a guard that only works for exactly two.
#nullable enable

using Marten;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Shouldly;
using Spend.Concurrency;
using Spend.Contracts;
using Spend.Slices.Spend;
using Spend.Views;
using Xunit;

namespace Spend.IntegrationTests.Concurrency;

public sealed class CrossAggregateRaceTests(AppFixture fixture) : IntegrationContext(fixture)
{
    private static readonly Guid Department = SeedData.DepartmentId;
    private static readonly Guid ProjectA = Guid.Parse("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    private static readonly Guid ProjectB = Guid.Parse("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");

    /// <summary>
    /// Arm 3 alone needs the raw connection string, because it must open its OWN connection and
    /// transaction to take the advisory lock before Marten is involved at all. Read from the host's
    /// configuration rather than the container, so it is by construction the same database the store uses
    /// — a lock taken on a different connection pool would be silently ineffective.
    /// </summary>
    private string ConnectionString =>
        Host.Services.GetRequiredService<IConfiguration>().GetConnectionString("Marten")!;

    /// <summary>
    /// One department, a budget, and two OPEN PROJECTS — two separate streams. That the two projects are
    /// different streams is the whole point: a race inside one stream is already handled by Marten's
    /// per-stream optimistic concurrency and would prove nothing.
    /// </summary>
    private async Task GivenABudgetOf(decimal budget)
    {
        await Given(Department, new DepartmentBudgetSet(Department, budget));
        await Given(ProjectA, new ProjectOpened(ProjectA, Department, "Rewire the hall"));
        await Given(ProjectB, new ProjectOpened(ProjectB, Department, "Repaint the foyer"));

        // THE GUARD ROW MUST ALREADY EXIST, and finding that out cost a red run worth keeping.
        //
        // Marten's Store() is an UPSERT — INSERT ... ON CONFLICT DO UPDATE — so two concurrent writers
        // that both find no guard both INSERT one and both succeed. A revision check can only bite on an
        // UPDATE, so a guard created lazily by the first writer to need it protects nothing precisely
        // when it matters. In production this row is created where the budget is: SetBudget owns it.
        await using var session = Store.LightweightSession();
        session.Store(new DepartmentBudgetGuard { Id = Department });
        await session.SaveChangesAsync();
    }

    private async Task<DepartmentSpend> Department_()
    {
        await using var session = Store.QuerySession();
        return (await session.LoadAsync<DepartmentSpend>(Department))!;
    }

    /// <summary>
    /// The invariant computed from the EVENT STORE, which is the only source of truth.
    ///
    /// ASSERTING IT ON THE PROJECTION WAS A TEST BUG, and an instructive one: under this race the inline
    /// multi-stream projection ALSO loses updates — both transactions load the same department row, both
    /// apply their own +70k, and the second store overwrites the first — so the view reports 70k while
    /// the store holds 140k of commitments. A test that trusted the view would have reported the budget
    /// intact while the money was gone twice. Read models are derived; invariants are checked against
    /// what was actually appended.
    /// </summary>
    private async Task<decimal> CommittedAccordingToTheEventStore()
    {
        await using var session = Store.QuerySession();
        var committed = await session.Events.QueryRawEventDataOnly<SpendCommitted>()
            .Where(e => e.DepartmentId == Department).ToListAsync();
        var released = await session.Events.QueryRawEventDataOnly<CommitmentReleased>()
            .Where(e => e.DepartmentId == Department).ToListAsync();
        return committed.Sum(e => e.Amount) - released.Sum(e => e.Amount);
    }

    /// <summary>
    /// Releases both writers only once BOTH have read. Turns "two requests at about the same moment"
    /// into an exact interleaving, so the control fails every run rather than most runs.
    /// </summary>
    private static Func<Task> Barrier(int writers)
    {
        var everyoneHasRead = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var arrived = 0;
        return async () =>
        {
            if (Interlocked.Increment(ref arrived) == writers) everyoneHasRead.SetResult();

            // THE TIMEOUT IS NOT DEFENSIVE PADDING. A writer that throws before arriving never increments,
            // so the writers that did arrive would await this for ever and the run would hang rather than
            // fail — the one failure mode a test suite must not have, because it reports as "still running"
            // instead of as a red test. WaitAsync turns it into a TimeoutException with a stack trace.
            await everyoneHasRead.Task.WaitAsync(TimeSpan.FromSeconds(30));
        };
    }

    // ---- the baseline. Passes against a broken mechanism, which is why it is not the point ----------

    [Fact]
    public async Task sequentially_the_naive_check_does_hold_the_budget()
    {
        await GivenABudgetOf(100_000m);

        (await CommitMechanisms.Naive(Store, new CommitSpend(ProjectA, Department, 70_000m)))
            .ShouldBe(CommitOutcome.Committed);

        // Different project, same department: the budget is a DEPARTMENT total. This is gwt-commit-2
        // run sequentially, and the naive check gets it right when nobody is racing it.
        (await CommitMechanisms.Naive(Store, new CommitSpend(ProjectB, Department, 40_000m)))
            .ShouldBe(CommitOutcome.BudgetExceeded);

        (await Department_()).Committed.ShouldBe(70_000m);
    }

    // ---- THE CONTROL. This test asserts the bug, and it is expected to pass ------------------------

    [Fact]
    public async Task CONTROL_two_projects_of_one_department_both_pass_the_naive_check_and_overspend()
    {
        await GivenABudgetOf(100_000m);
        var barrier = Barrier(2);

        // Each is individually affordable against a 100k budget. Together they are not.
        var a = CommitMechanisms.Naive(Store, new CommitSpend(ProjectA, Department, 70_000m), barrier);
        var b = CommitMechanisms.Naive(Store, new CommitSpend(ProjectB, Department, 70_000m), barrier);
        var outcomes = await Task.WhenAll(a, b);

        // BOTH succeed. Neither transaction touched a row the other touched — two different project
        // streams — so Postgres had no conflict to detect and Marten had no version to compare.
        outcomes.ShouldAllBe(o => o == CommitOutcome.Committed);

        // THE INVARIANT IS BROKEN, measured against the event store. Asserted broken on purpose: if this
        // line ever starts passing the other way, the naive arm has accidentally become correct and every
        // conclusion drawn from the other arms needs re-checking.
        var actuallyCommitted = await CommittedAccordingToTheEventStore();
        actuallyCommitted.ShouldBe(140_000m);
        actuallyCommitted.ShouldBeGreaterThan(100_000m);

        // AND THE READ MODEL IS WRONG TOO, which is a second defect the same race causes and which no
        // amount of care in the decider would fix. Two inline projection updates to one department row,
        // in two transactions that touch no common stream: both load, both apply, the second overwrites.
        // The view under-reports the damage, so a dashboard would show the budget intact.
        var department = await Department_();
        department.Budget.ShouldBe(100_000m);
        department.Committed.ShouldBeLessThan(actuallyCommitted);
    }

    // ---- ARM 1. The same test the control fails, against a guard row. No DCB ----------------------

    [Fact]
    public async Task guard_row_lets_exactly_one_of_two_racing_commits_through()
    {
        await GivenABudgetOf(100_000m);
        var barrier = Barrier(2);

        var a = CommitMechanisms.GuardRow(Store, new CommitSpend(ProjectA, Department, 70_000m), barrier);
        var b = CommitMechanisms.GuardRow(Store, new CommitSpend(ProjectB, Department, 70_000m), barrier);
        var outcomes = await Task.WhenAll(a, b);

        outcomes.Count(o => o == CommitOutcome.Committed).ShouldBe(1);
        outcomes.Count(o => o == CommitOutcome.Conflict).ShouldBe(1);

        // The invariant, from the event store. This is the line the control cannot make true.
        (await CommittedAccordingToTheEventStore()).ShouldBe(70_000m);

        // And the read model agrees, because only one transaction wrote the department row.
        (await Department_()).Committed.ShouldBe(70_000m);
    }

    [Fact]
    public async Task guard_row_holds_the_budget_under_unstaged_contention()
    {
        await GivenABudgetOf(100_000m);

        var projects = Enumerable.Range(0, 10)
            .Select(i => Guid.Parse($"dddddddd-dddd-dddd-dddd-{i:D12}")).ToArray();
        foreach (var p in projects) await Given(p, new ProjectOpened(p, Department, $"Project {p:N}"));

        var outcomes = await Task.WhenAll(projects.Select(p =>
            CommitMechanisms.GuardRow(Store, new CommitSpend(p, Department, 15_000m))));

        // Whatever the split between committed, refused and conflicted, the invariant must hold. That is
        // the only assertion that matters: a mechanism is allowed to be pessimistic, never wrong.
        var committed = await CommittedAccordingToTheEventStore();
        committed.ShouldBeLessThanOrEqualTo(100_000m);
        outcomes.ShouldContain(CommitOutcome.Committed);
    }

    /// <summary>
    /// THE TEST THAT STOPS THE OTHER TWO PASSING FOR THE WRONG REASON.
    ///
    /// Neither arm-1 test above can tell a working guard from one that simply refuses everything after
    /// the first commit: the deterministic test asserts exactly one commit — which such a guard also
    /// produces — and the stress test only asserts that SOME commit got through. A mechanism that
    /// serialised a whole department down to one commit for ever would show green on both while being
    /// useless.
    ///
    /// So: three uncontended commits, two of which fit. Both must be COMMITTED, not conflicted — which
    /// is only true if the revision keeps incrementing cleanly across separate sessions — and the third
    /// must be refused by the budget rule rather than by the guard.
    /// </summary>
    [Fact]
    public async Task guard_row_still_allows_successive_commits_that_fit()
    {
        await GivenABudgetOf(100_000m);

        (await CommitMechanisms.GuardRow(Store, new CommitSpend(ProjectA, Department, 40_000m)))
            .ShouldBe(CommitOutcome.Committed);

        // A DIFFERENT project stream of the same department, so this is the cross-stream path and not a
        // second append to one stream. Uncontended, it must not conflict.
        (await CommitMechanisms.GuardRow(Store, new CommitSpend(ProjectB, Department, 40_000m)))
            .ShouldBe(CommitOutcome.Committed);

        // BudgetExceeded, NOT Conflict. The distinction is the point: the guard must be invisible when
        // nobody is racing, leaving the business rule to do the refusing.
        (await CommitMechanisms.GuardRow(Store, new CommitSpend(ProjectA, Department, 40_000m)))
            .ShouldBe(CommitOutcome.BudgetExceeded);

        (await CommittedAccordingToTheEventStore()).ShouldBe(80_000m);
    }

    // ---- ARM 2. A reservation row, guarded by a unique index ---------------------------------------

    [Fact]
    public async Task reservation_row_lets_exactly_one_of_two_racing_commits_through()
    {
        await GivenABudgetOf(100_000m);
        var barrier = Barrier(2);

        var a = CommitMechanisms.ReservationRow(Store, new CommitSpend(ProjectA, Department, 70_000m), barrier);
        var b = CommitMechanisms.ReservationRow(Store, new CommitSpend(ProjectB, Department, 70_000m), barrier);
        var outcomes = await Task.WhenAll(a, b);

        outcomes.Count(o => o == CommitOutcome.Committed).ShouldBe(1);
        outcomes.Count(o => o == CommitOutcome.Conflict).ShouldBe(1);

        (await CommittedAccordingToTheEventStore()).ShouldBe(70_000m);
    }

    [Fact]
    public async Task reservation_row_still_allows_successive_commits_that_fit()
    {
        await GivenABudgetOf(100_000m);

        (await CommitMechanisms.ReservationRow(Store, new CommitSpend(ProjectA, Department, 40_000m)))
            .ShouldBe(CommitOutcome.Committed);
        (await CommitMechanisms.ReservationRow(Store, new CommitSpend(ProjectB, Department, 40_000m)))
            .ShouldBe(CommitOutcome.Committed);
        (await CommitMechanisms.ReservationRow(Store, new CommitSpend(ProjectA, Department, 40_000m)))
            .ShouldBe(CommitOutcome.BudgetExceeded);

        (await CommittedAccordingToTheEventStore()).ShouldBe(80_000m);
    }

    [Fact]
    public async Task reservation_row_holds_the_budget_under_unstaged_contention()
    {
        await GivenABudgetOf(100_000m);

        var projects = Enumerable.Range(0, 10)
            .Select(i => Guid.Parse($"faaaaaaa-aaaa-aaaa-aaaa-{i:D12}")).ToArray();
        foreach (var p in projects) await Given(p, new ProjectOpened(p, Department, $"Project {p:N}"));

        var outcomes = await Task.WhenAll(projects.Select(p =>
            CommitMechanisms.ReservationRow(Store, new CommitSpend(p, Department, 15_000m))));

        (await CommittedAccordingToTheEventStore()).ShouldBeLessThanOrEqualTo(100_000m);
        outcomes.ShouldContain(CommitOutcome.Committed);
    }

    // ---- ARM 5. The Reservation Pattern: the event store's own stream table is the unique index -------

    [Fact]
    public async Task reservation_stream_lets_exactly_one_of_two_racing_commits_through()
    {
        await GivenABudgetOf(100_000m);
        var barrier = Barrier(2);

        var a = CommitMechanisms.ReservationStream(Store, new CommitSpend(ProjectA, Department, 70_000m), barrier);
        var b = CommitMechanisms.ReservationStream(Store, new CommitSpend(ProjectB, Department, 70_000m), barrier);
        var outcomes = await Task.WhenAll(a, b);

        outcomes.Count(o => o == CommitOutcome.Committed).ShouldBe(1);
        outcomes.Count(o => o == CommitOutcome.Conflict).ShouldBe(1);

        (await CommittedAccordingToTheEventStore()).ShouldBe(70_000m);
    }

    [Fact]
    public async Task reservation_stream_still_allows_successive_commits_that_fit()
    {
        await GivenABudgetOf(100_000m);

        // Slot 0, then slot 1 — DIFFERENT streams, so no collision. This is the test that would fail if the
        // slot were constant: the mechanism would then refuse every commit after the first, which the two
        // tests above cannot distinguish from working correctly.
        (await CommitMechanisms.ReservationStream(Store, new CommitSpend(ProjectA, Department, 40_000m)))
            .ShouldBe(CommitOutcome.Committed);
        (await CommitMechanisms.ReservationStream(Store, new CommitSpend(ProjectB, Department, 40_000m)))
            .ShouldBe(CommitOutcome.Committed);

        (await CommitMechanisms.ReservationStream(Store, new CommitSpend(ProjectA, Department, 40_000m)))
            .ShouldBe(CommitOutcome.BudgetExceeded);

        (await CommittedAccordingToTheEventStore()).ShouldBe(80_000m);
    }

    [Fact]
    public async Task reservation_stream_holds_the_budget_under_unstaged_contention()
    {
        await GivenABudgetOf(100_000m);

        var projects = Enumerable.Range(0, 10)
            .Select(i => Guid.Parse($"fccccccc-cccc-cccc-cccc-{i:D12}")).ToArray();
        foreach (var p in projects) await Given(p, new ProjectOpened(p, Department, $"Project {p:N}"));

        var outcomes = await Task.WhenAll(projects.Select(p =>
            CommitMechanisms.ReservationStream(Store, new CommitSpend(p, Department, 15_000m))));

        (await CommittedAccordingToTheEventStore()).ShouldBeLessThanOrEqualTo(100_000m);
        outcomes.ShouldContain(CommitOutcome.Committed);
    }

    // ---- ARM 3. An advisory lock: serialisation, so the loser is refused rather than conflicted ------

    /// <summary>
    /// NO BARRIER, AND THAT IS THE FINDING RATHER THAN A SHORTCUT.
    ///
    /// Every other arm is tested by forcing both writers to read before either writes. Arm 3 makes that
    /// impossible by design: writer A holds the lock while it reads, so writer B cannot reach its own read
    /// until A has finished and committed. Passing a Barrier(2) here deadlocks — A waits at the barrier for
    /// B, B waits on the lock for A — and would surface as the barrier's 30-second TimeoutException.
    ///
    /// So a mechanism that serialises BEFORE the read cannot be observed by a read-barrier, because
    /// preventing simultaneous reads is precisely what it does. What is asserted instead is the outcome
    /// SHAPE, and it differs from every other arm: the loser is refused by the budget rule, not by a
    /// conflict, so nothing retries.
    /// </summary>
    [Fact]
    public async Task advisory_lock_serialises_so_the_loser_is_refused_rather_than_conflicted()
    {
        await GivenABudgetOf(100_000m);

        var a = CommitMechanisms.AdvisoryLock(Store, ConnectionString, new CommitSpend(ProjectA, Department, 70_000m));
        var b = CommitMechanisms.AdvisoryLock(Store, ConnectionString, new CommitSpend(ProjectB, Department, 70_000m));
        var outcomes = await Task.WhenAll(a, b);

        outcomes.Count(o => o == CommitOutcome.Committed).ShouldBe(1);

        // THE DISTINGUISHING ASSERTION. Arms 1, 2 and 4 produce a Conflict here; this one produces an
        // ordinary refusal, because the loser read state that already included the winner's commit.
        outcomes.Count(o => o == CommitOutcome.BudgetExceeded).ShouldBe(1);
        outcomes.ShouldNotContain(CommitOutcome.Conflict);

        (await CommittedAccordingToTheEventStore()).ShouldBe(70_000m);
    }

    [Fact]
    public async Task advisory_lock_still_allows_successive_commits_that_fit()
    {
        await GivenABudgetOf(100_000m);

        (await CommitMechanisms.AdvisoryLock(Store, ConnectionString, new CommitSpend(ProjectA, Department, 40_000m)))
            .ShouldBe(CommitOutcome.Committed);
        (await CommitMechanisms.AdvisoryLock(Store, ConnectionString, new CommitSpend(ProjectB, Department, 40_000m)))
            .ShouldBe(CommitOutcome.Committed);
        (await CommitMechanisms.AdvisoryLock(Store, ConnectionString, new CommitSpend(ProjectA, Department, 40_000m)))
            .ShouldBe(CommitOutcome.BudgetExceeded);

        (await CommittedAccordingToTheEventStore()).ShouldBe(80_000m);
    }

    /// <summary>
    /// Ten writers, and because this arm serialises rather than conflicts, the expected outcome is
    /// SHARPER than the other arms': exactly six commit and four are refused, every run. Nothing is lost
    /// to a conflict, so the budget is not merely respected but fully used.
    /// </summary>
    [Fact]
    public async Task advisory_lock_holds_the_budget_under_unstaged_contention()
    {
        await GivenABudgetOf(100_000m);

        var projects = Enumerable.Range(0, 10)
            .Select(i => Guid.Parse($"fbbbbbbb-bbbb-bbbb-bbbb-{i:D12}")).ToArray();
        foreach (var p in projects) await Given(p, new ProjectOpened(p, Department, $"Project {p:N}"));

        var outcomes = await Task.WhenAll(projects.Select(p =>
            CommitMechanisms.AdvisoryLock(Store, ConnectionString, new CommitSpend(p, Department, 15_000m))));

        (await CommittedAccordingToTheEventStore()).ShouldBeLessThanOrEqualTo(100_000m);

        // 6 x 15k = 90k fits, 7 would not. A serialising mechanism wastes nothing, so this is exact.
        outcomes.Count(o => o == CommitOutcome.Committed).ShouldBe(6);
        outcomes.Count(o => o == CommitOutcome.BudgetExceeded).ShouldBe(4);
    }

    // ---- ARM 4. DCB: the boundary is a tag query, not a stream --------------------------------------

    [Fact]
    public async Task dcb_lets_exactly_one_of_two_racing_commits_through()
    {
        await GivenABudgetOf(100_000m);
        var barrier = Barrier(2);

        var a = CommitMechanisms.Dcb(Store, new CommitSpend(ProjectA, Department, 70_000m), 100_000m, barrier);
        var b = CommitMechanisms.Dcb(Store, new CommitSpend(ProjectB, Department, 70_000m), 100_000m, barrier);
        var outcomes = await Task.WhenAll(a, b);

        outcomes.Count(o => o == CommitOutcome.Committed).ShouldBe(1);
        outcomes.Count(o => o == CommitOutcome.Conflict).ShouldBe(1);
        (await CommittedAccordingToTheEventStore()).ShouldBe(70_000m);
    }

    [Fact]
    public async Task dcb_holds_the_budget_under_unstaged_contention()
    {
        await GivenABudgetOf(100_000m);

        var projects = Enumerable.Range(0, 10)
            .Select(i => Guid.Parse($"eeeeeeee-eeee-eeee-eeee-{i:D12}")).ToArray();
        foreach (var p in projects) await Given(p, new ProjectOpened(p, Department, $"Project {p:N}"));

        var outcomes = await Task.WhenAll(projects.Select(p =>
            CommitMechanisms.Dcb(Store, new CommitSpend(p, Department, 15_000m), 100_000m)));

        (await CommittedAccordingToTheEventStore()).ShouldBeLessThanOrEqualTo(100_000m);
        outcomes.ShouldContain(CommitOutcome.Committed);
    }

    /// <summary>
    /// The same wrong-reason guard as <see cref="guard_row_still_allows_successive_commits_that_fit"/>,
    /// applied to DCB. A tag version that never advanced cleanly — or a boundary fold that read zero
    /// every time — would still show green on both DCB tests above.
    ///
    /// This one also pins the FOLD, which nothing else does: the third call can only be refused if
    /// FetchForWritingByTags actually accumulated 80,000 across TWO DIFFERENT project streams. That is
    /// the cross-stream read the whole pattern rests on.
    /// </summary>
    [Fact]
    public async Task dcb_still_allows_successive_commits_that_fit()
    {
        await GivenABudgetOf(100_000m);

        (await CommitMechanisms.Dcb(Store, new CommitSpend(ProjectA, Department, 40_000m), 100_000m))
            .ShouldBe(CommitOutcome.Committed);

        (await CommitMechanisms.Dcb(Store, new CommitSpend(ProjectB, Department, 40_000m), 100_000m))
            .ShouldBe(CommitOutcome.Committed);

        (await CommitMechanisms.Dcb(Store, new CommitSpend(ProjectA, Department, 40_000m), 100_000m))
            .ShouldBe(CommitOutcome.BudgetExceeded);

        (await CommittedAccordingToTheEventStore()).ShouldBe(80_000m);
    }

    [Fact]
    public async Task CONTROL_stress_without_a_barrier_also_overspends()
    {
        await GivenABudgetOf(100_000m);

        // Ten writers, ten separate project streams, each asking for a tenth of the budget plus a bit.
        // No barrier: this is ordinary contention, and it is here to show the deterministic test is not
        // an artefact of the barrier.
        var projects = Enumerable.Range(0, 10)
            .Select(i => Guid.Parse($"cccccccc-cccc-cccc-cccc-{i:D12}")).ToArray();
        foreach (var p in projects) await Given(p, new ProjectOpened(p, Department, $"Project {p:N}"));

        var outcomes = await Task.WhenAll(projects.Select(p =>
            CommitMechanisms.Naive(Store, new CommitSpend(p, Department, 15_000m))));

        var committed = outcomes.Count(o => o == CommitOutcome.Committed);

        // 10 x 15k = 150k against a 100k budget. At most 6 may legitimately be committed.
        committed.ShouldBeGreaterThan(6);
        (await CommittedAccordingToTheEventStore()).ShouldBeGreaterThan(100_000m);
    }
}
