// Hand-written. Not generated from the model, and it must not be: no GWT can express "at the same
// instant", and every generated GWT in this project is sequential.
#nullable enable

using Marten;
using Marten.Events;
using Allocation.Contracts;
using Allocation.Slices.Allocation;
using Shouldly;
using Xunit;

namespace Allocation.IntegrationTests.Concurrency;

/// <summary>
/// THE RESERVATION STEP UNDER CONTENTION. Four questions, in the order `architect` asks them to be asked:
///
///   1. THE CONTROL — does the race reproduce at all without a guard? A green "exactly one wins" and a
///      race that never happened are the same green, and only the control tells them apart.
///   2. the mechanism, on a stream that must be CREATED — the first claim on a unit.
///   3. the mechanism, on a stream that ALREADY EXISTS — a released unit being taken again. This is the
///      case a bare StartStream collision cannot guard, and the reason this folder is not a restatement
///      of arm 5 in cross-aggregate-invariant/.
///   4. the wrong-reason guard — a mechanism that refused everything after the first write would pass
///      1–3 while being useless, so uncontended reservations that fit must still all succeed.
///
/// And every assertion is on THE EVENT STORE, never on PoolAvailability. The same race that double-books a
/// unit also makes two projection updates overwrite each other, so the view UNDER-REPORTS the damage and a
/// test trusting it would show the pool intact while the unit was handed out twice. KIT-FINDINGS AD12.
/// </summary>
public sealed class ReservationRaceTests(AppFixture fixture) : IntegrationContext(fixture)
{
    private const int Slot = 1;
    private static string PoolStream => OpenPoolState.StreamKey(SeedData.PoolId.ToString());
    private static string SlotStream(int n) => ReserveSlotState.StreamKey(SeedData.PoolId, n);

    private Task OpenPool(int capacity) =>
        Given(PoolStream, new PoolOpened(SeedData.PoolId, capacity, SeedData.SeededAt));

    /// <summary>A unit that has been taken and given back: its stream EXISTS and is free.</summary>
    private Task AFreedSlot() => Given(SlotStream(Slot),
        new SlotReserved(SeedData.PoolId, Slot, SeedData.GrantId, SeedData.SeededAt),
        new SlotReleased(SeedData.PoolId, Slot, SeedData.GrantId, "test", SeedData.SeededAt));

    /// <summary>How many holders the STORE thinks this unit has. Never ask the view.</summary>
    private async Task<int> HoldersAccordingToTheEventStore(int slot)
    {
        await using var session = Store.QuerySession();
        var events = await session.Events.FetchStreamAsync(SlotStream(slot));
        // Reserved minus released, in order: how many times the unit was handed out and not given back.
        return events.Select(e => e.Data).Aggregate(0, (n, e) => e switch
        {
            SlotReserved => n + 1,
            SlotReleased => n - 1,
            _ => n,
        });
    }

    // ─────────────────────────────────────────────────────────────────────────────────────────────
    // 1. THE CONTROL
    // ─────────────────────────────────────────────────────────────────────────────────────────────

    /// <summary>
    /// A GREEN TEST THAT ASSERTS THE INVARIANT IS BROKEN. If it ever starts failing, the naive design has
    /// accidentally become correct and every conclusion drawn from the tests below needs re-checking.
    ///
    /// THE CONTROL IS A DIFFERENT DESIGN, NOT A CARELESS ONE, and finding that out was the sharpest
    /// measurement in this folder. The obvious control — the same enumerated slots, appended without
    /// FetchForWriting — DOES NOT REPRODUCE. Marten 9 refuses the second concurrent append to one stream
    /// on `pk_mt_events_stream_and_version`, the event table's own primary key, with no optimistic
    /// concurrency API involved anywhere: `Won=1, VersionConflict=1`, deterministically, and the message
    /// is literally *duplicate key value violates unique constraint*.
    ///
    /// So there is no careless way to double-book an enumerated unit. Which is the Reservation Pattern's
    /// whole claim, arrived at from the other side: once the contested thing IS a stream, the guarantee is
    /// in the table rather than in anybody's discipline. `FetchForWriting` buys the FOLD and a clean
    /// exception; it does not buy the guarantee.
    ///
    /// What CAN be broken is the design the pattern replaces: a RUNNING TOTAL. Give each grant its own
    /// stream and check the limit by counting, and two writers who both count "0 of 1 used" both append to
    /// streams that share no row — so Postgres has nothing to detect, both succeed, and a pool of one has
    /// two holders. That is arm 0 of cross-aggregate-invariant/ in miniature, and it is what the
    /// enumeration exists to make unrepresentable.
    /// </summary>
    [Fact]
    public async Task CONTROL_a_running_total_lets_two_writers_past_a_pool_of_one()
    {
        await OpenPool(1);

        var results = await ConcurrencyHarness.RaceAsync(2, async (i, session) =>
        {
            // THE COUNT. Every reservation this pool has ever handed out, read across streams — which is
            // exactly what a design without slot numbers has to do, and exactly what no stream's version
            // can cover.
            var used = await session.Events.QueryRawEventDataOnly<SlotReserved>()
                .Where(e => e.PoolId == SeedData.PoolId)
                .CountAsync();

            var pool = await session.Events.FetchLatest<OpenPoolState>(
                OpenPoolState.StreamKey(SeedData.PoolId.ToString()));

            if (used >= (pool?.Capacity ?? 0)) return false;

            // ITS OWN STREAM, one per grant. No two writers touch a common row, so there is nothing to
            // conflict on — the failure is in the shape of the data, not in the care of the programmer.
            var grantId = Guid.NewGuid();
            session.Events.StartStream<ReserveSlotState>(
                $"naive:{grantId}",
                new SlotReserved(SeedData.PoolId, i + 100, grantId, DateTimeOffset.UtcNow));
            return true;
        }, Store);

        results.Count(RaceOutcome.Won)
            .ShouldBe(2, "the control must reproduce the over-allocation, or the tests below prove nothing. " +
                         results.Describe());

        await using var query = Store.QuerySession();
        var handedOut = await query.Events.QueryRawEventDataOnly<SlotReserved>()
            .Where(e => e.PoolId == SeedData.PoolId)
            .CountAsync();
        handedOut.ShouldBe(2, "a pool of one has handed out two units");
    }

    // ─────────────────────────────────────────────────────────────────────────────────────────────
    // 2 and 3. THE MECHANISM
    // ─────────────────────────────────────────────────────────────────────────────────────────────

    /// <summary>
    /// FIRST CLAIM on a unit: the stream does not exist, so the loser is refused by the stream table's own
    /// primary key. This is the case ch. 36's e-mail example is entirely about, and the one arm 5 of
    /// cross-aggregate-invariant/ already measured — included here so the pair below is a comparison.
    /// </summary>
    [Fact]
    public async Task Two_reservers_creating_the_same_unit_only_one_wins()
    {
        await OpenPool(1);

        var results = await ConcurrencyHarness.RaceAsync(4, async (i, session) =>
        {
            var stream = await session.Events.FetchForWriting<ReserveSlotState>(SlotStream(Slot));
            if (stream.Aggregate is { Held: true }) return false;
            stream.AppendOne(new SlotReserved(SeedData.PoolId, Slot, Guid.NewGuid(), DateTimeOffset.UtcNow));
            return true;
        }, Store);

        results.Count(RaceOutcome.Won).ShouldBe(1, results.Describe());
        results.Count(RaceOutcome.Unexpected).ShouldBe(0, results.Describe());
        (await HoldersAccordingToTheEventStore(Slot)).ShouldBe(1);
    }

    /// <summary>
    /// RE-CLAIMING a unit that was given back — and this is the test that separates this folder from arm 5.
    ///
    /// The stream already exists, so there is no creation to collide on: a guard built on
    /// ExistingStreamIdCollision has nothing to refuse and both writers get through. What refuses the
    /// loser here is the stream's VERSION, captured by FetchForWriting — which is the mechanism the book's
    /// ReserveEmailAggregate actually uses, with its `reserved` flag, rather than the creation trick its
    /// prose emphasises.
    /// </summary>
    [Fact]
    public async Task Two_reservers_re_taking_a_freed_unit_only_one_wins()
    {
        await OpenPool(1);
        await AFreedSlot();

        var results = await ConcurrencyHarness.RaceAsync(4, async (i, session) =>
        {
            var stream = await session.Events.FetchForWriting<ReserveSlotState>(SlotStream(Slot));
            if (stream.Aggregate is { Held: true }) return false;
            stream.AppendOne(new SlotReserved(SeedData.PoolId, Slot, Guid.NewGuid(), DateTimeOffset.UtcNow));
            return true;
        }, Store);

        results.Count(RaceOutcome.Won).ShouldBe(1, results.Describe());
        results.Count(RaceOutcome.StreamCollision)
            .ShouldBe(0, "the stream already existed, so nothing can be refused by CREATING it — " +
                         "which is exactly why a create-collision guard would let all four through");
        (await HoldersAccordingToTheEventStore(Slot)).ShouldBe(1);
    }

    // ─────────────────────────────────────────────────────────────────────────────────────────────
    // 4. THE WRONG-REASON GUARD, and the end-to-end limit
    // ─────────────────────────────────────────────────────────────────────────────────────────────

    /// <summary>
    /// A MECHANISM THAT REFUSED EVERYTHING AFTER THE FIRST RESERVATION would pass every test above. So:
    /// with nobody racing, a pool of three hands out three units and refuses the fourth — and the fourth
    /// is refused by the LIMIT, not by the guard.
    /// </summary>
    [Fact]
    public async Task Uncontended_reservations_that_fit_all_succeed()
    {
        await OpenPool(3);

        var taken = new List<int>();
        for (var i = 0; i < 3; i++)
        {
            var result = await SlotReservation.Reserve(Store, SeedData.PoolId, Guid.NewGuid());
            result.Outcome.Accepted.ShouldBeTrue(result.Outcome.ToString());
            taken.Add(result.Reserved!.SlotNumber);
        }

        taken.ShouldBe([1, 2, 3]);

        var fourth = await SlotReservation.Reserve(Store, SeedData.PoolId, Guid.NewGuid());
        fourth.Outcome.Accepted.ShouldBeFalse();
        fourth.Outcome.Error.ShouldBe(SlotReservation.PoolExhausted);
    }

    /// <summary>
    /// THE WHOLE POINT, END TO END: ten callers at once against a pool of six, through the real reserve
    /// path with its retry loop. Exactly six units are handed out, each exactly once, and four callers are
    /// told the pool is full.
    ///
    /// No guard row, no unique index, no advisory lock, no DCB — the limit is held by there being six
    /// stream keys and each admitting one holder. That is the Reservation Pattern's payoff stated as a
    /// number, and it is what BOOK-INDEX §2 gap 2 predicted ("the cheapest of them, and needs no extra
    /// row, index or lock") before any of this was built.
    /// </summary>
    [Fact]
    public async Task Ten_callers_against_a_pool_of_six_get_exactly_six_units()
    {
        const int capacity = 6;
        const int callers = 10;
        await OpenPool(capacity);

        // A starting gun, so all ten are genuinely in flight together rather than serialised by the
        // scheduler. Task.WhenAll alone is not a race — the harness's own comment, and it applies here.
        var gate = new TaskCompletionSource();
        var runs = Enumerable.Range(0, callers).Select(async _ =>
        {
            await gate.Task;
            return await SlotReservation.Reserve(Store, SeedData.PoolId, Guid.NewGuid());
        }).ToArray();

        gate.SetResult();
        var results = await Task.WhenAll(runs);

        var won = results.Where(r => r.Outcome.Accepted).ToArray();
        var refused = results.Where(r => !r.Outcome.Accepted).ToArray();

        won.Length.ShouldBe(capacity, "the pool has six units, so six callers and no more may hold one");
        refused.Length.ShouldBe(callers - capacity);
        refused.ShouldAllBe(r => r.Outcome.Error == SlotReservation.PoolExhausted);

        // EACH UNIT ONCE. Six successes could also be six callers sharing three units, which is the
        // failure the count alone cannot see.
        won.Select(r => r.Reserved!.SlotNumber).Order().ShouldBe([1, 2, 3, 4, 5, 6]);
        for (var slot = 1; slot <= capacity; slot++)
            (await HoldersAccordingToTheEventStore(slot)).ShouldBe(1, $"slot {slot}");
    }
}
