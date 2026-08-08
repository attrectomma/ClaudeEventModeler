// HAND-OWNED. Not scaffolded, not emitted — the comparison IS this folder's content.
//
// One command, CommitSpend, implemented several ways. Every arm enforces the same rule:
//
//     the sum of committed-minus-released across EVERY Project stream of a Department
//     must never exceed that Department's budget
//
// which the model states as gwt-commit-2 — a GIVEN in a stream the command does not write to. Each arm
// differs only in what makes the read-then-append atomic with respect to another writer doing the same
// thing to a DIFFERENT project stream of the same department.
#nullable enable

using JasperFx.Events;
using JasperFx.Events.Tags;   // EventTagQuery — dcb.md names no namespace for it either
using Marten;
using Marten.Events;
using Spend.Contracts;
using Spend.Slices.Spend;
using Spend.Views;

namespace Spend.Concurrency;

/// <summary>What a commit attempt did. Deliberately not an exception: "refused" is an ordinary outcome.</summary>
public enum CommitOutcome
{
    /// <summary>The event was appended.</summary>
    Committed,

    /// <summary>Refused: the department's budget could not cover it. The rule working.</summary>
    BudgetExceeded,

    /// <summary>A concurrent writer won. The caller may retry — the rule working under contention.</summary>
    Conflict,
}

/// <summary>
/// ARM 1's guard row: one per department, holding nothing.
///
/// Its only job is to be a row that every writer in the department WRITES, so that two commits to two
/// different project streams collide somewhere. That is Marten's own recipe for DCB stated generally —
/// the migration guide describes the side table as converting "the predicate read into a row-level write
/// conflict, so concurrent boundary saves serialize on a row lock at READ COMMITTED".
///
/// <c>IRevisioned</c> needs NO store configuration: the docs say Store() on such a document "is
/// essentially IDocumentSession.UpdateRevision(entity, entity.Version)", so a stale version throws.
/// That matters practically — it means this arm can share a host with the others, while anything
/// configured per document type (UseOptimisticConcurrency) or per store (tag types) cannot.
/// </summary>
// JasperFx.IRevisioned, NOT Marten.Metadata.IRevisioned — it moved into the shared JasperFx library for
// Marten 9, and no doc page says so. Found by grepping the package's own .xml, which is the kit's
// documented tiebreaker when the mirror is silent.
public sealed class DepartmentBudgetGuard : JasperFx.IRevisioned
{
    public Guid Id { get; set; }
    public int Version { get; set; }
}

/// <summary>
/// ARM 2's reservation row: one row per accepted commit, carrying the SEQUENCE it claimed.
///
/// Unlike arm 1's guard — one row per department, updated in place — this table grows by a row per
/// commit, and the collision is an INSERT rejected by a unique index rather than an UPDATE rejected by
/// a version predicate. Same strategy stated generally (turn the predicate into a row-level write
/// conflict), different Postgres primitive.
///
/// The Id is a fresh Guid on purpose: it must NOT be the thing that collides, or this arm would just be
/// arm 1 with the primary key doing the work. The unique index over (DepartmentId, Sequence) is the
/// mechanism, and it is declared in ViewRegistrations.
/// </summary>
public sealed class BudgetReservation
{
    public Guid Id { get; set; }
    public Guid DepartmentId { get; set; }
    public int Sequence { get; set; }
    public decimal Amount { get; set; }
}

/// <summary>
/// The DCB tag: a strong-typed wrapper, which the docs require ("Tag types should be simple wrapper
/// records around a primitive value"). Named Tag rather than DepartmentId because the events already
/// carry a plain Guid DepartmentId and the two must not be confused.
/// </summary>
public sealed record DepartmentTag(Guid Value);

/// <summary>
/// A PURE BOUNDARY AGGREGATE — no Id, no stream identity. It exists only as the fold of the events a tag
/// query selects, which is exactly the shape our invariant has: a predicate over many streams.
/// [BoundaryAggregate] is the required opt-in; without it the source generator emits no dispatcher and
/// FetchForWritingByTags throws.
/// </summary>
// JasperFx.Events.Aggregation, not JasperFx.Events — the dcb.md page writes it bare as
// [BoundaryAggregate] and names no namespace. Found by grepping JasperFx.Events.xml.
[JasperFx.Events.Aggregation.BoundaryAggregate]
public partial class DepartmentBoundary
{
    // AN Id, DESPITE THE DOCS. dcb.md says a pure boundary aggregate "has no Id property and no
    // [AggregateIdentity]" and that [BoundaryAggregate] is the marker that makes that legal. On Marten
    // 9.22.5 registering it via RegisterTagType(...).ForAggregate<T>() still routes the type through the
    // document mapper, which throws InvalidDocumentException("Could not determine an 'id/Id' field").
    // The docs' own worked example (StudentCourseEnrollment) carries one and "doubles as an ordinary
    // aggregate", so this follows the example rather than the prose.
    public Guid Id { get; set; }

    public decimal Committed { get; set; }

    public void Apply(SpendCommitted e) => Committed += e.Amount;
    // MUTATION-CHECKED: replacing this body with a no-op fails exactly one test —
    // CommitSpendTests.AReleaseFreesTheBudgetForALaterCommitment — and no other. That is the test earning
    // its place: every other scenario only ever adds, so nothing else can see a fold that ignores releases.
    public void Apply(CommitmentReleased e) => Committed -= e.Amount;
}

public static class CommitMechanisms
{
    /// <summary>
    /// ARM 0 — THE CONTROL, AND IT IS KNOWN-BROKEN ON PURPOSE.
    ///
    /// Read the multi-stream projection, check the sum, append to this project's stream. This is what
    /// "just use a multi-stream aggregation" means when written out, and it is the shape almost anyone
    /// reaches for first — the projection is even registered <c>Inline</c> here, so the read is not
    /// stale by a single event.
    ///
    /// It is still wrong, and the reason is worth stating precisely: <b>nothing in this transaction
    /// covers the thing being contended</b>. Marten's optimistic concurrency protects a STREAM, and the
    /// two writers are appending to two different project streams. Neither transaction touches a row the
    /// other touches, so Postgres has no conflict to detect and both commit. The department total is not
    /// a stream, so it is not guarded by a stream's version.
    ///
    /// Current-but-unguarded is exactly the failure mode, and <c>FetchLatest</c> would not help: it is
    /// documented read-only and adds no check at save time.
    /// </summary>
    /// <param name="afterRead">
    /// TEST-ONLY seam, null in every production path. It makes the race DETERMINISTIC rather than
    /// probabilistic: the test releases both writers only once both have read. Without it the control
    /// test would be a stress test that usually reproduces the bug, and "usually" is not a proof — a
    /// flaky control is worse than none, because a green run reads as a fixed race.
    /// </param>
    public static async Task<CommitOutcome> Naive(
        IDocumentStore store, CommitSpend cmd, Func<Task>? afterRead = null)
    {
        await using var session = store.LightweightSession();

        var view = await session.LoadAsync<DepartmentSpend>(cmd.DepartmentId);
        var budget = view?.Budget ?? 0m;
        var committed = view?.Committed ?? 0m;

        if (afterRead is not null) await afterRead();

        if (committed + cmd.Amount > budget) return CommitOutcome.BudgetExceeded;

        session.Events.Append(cmd.ProjectId, new SpendCommitted(cmd.ProjectId, cmd.DepartmentId, cmd.Amount));
        await session.SaveChangesAsync();
        return CommitOutcome.Committed;
    }

    /// <summary>
    /// ARM 1 — A GUARD ROW, AND NO DCB.
    ///
    /// Identical to <see cref="Naive"/> except for one line: the department's guard document is stored in
    /// the SAME transaction as the append. That converts a predicate over many streams into a write both
    /// contenders perform on one row, which is the only thing Postgres can detect a conflict on.
    ///
    /// The loser gets <see cref="CommitOutcome.Conflict"/> rather than a wrong answer, and a caller may
    /// retry — on retry it re-reads and is then correctly refused by the budget check. That is the same
    /// contract DCB offers via DcbConcurrencyException.
    ///
    /// COST, stated plainly: every commit in a department contends on one row, so writes across all its
    /// projects serialize. That is the price of the invariant being real, and it is the same price DCB
    /// pays on its tag-version row.
    /// </summary>
    public static async Task<CommitOutcome> GuardRow(
        IDocumentStore store, CommitSpend cmd, Func<Task>? afterRead = null)
    {
        await using var session = store.LightweightSession();

        var guard = await session.LoadAsync<DepartmentBudgetGuard>(cmd.DepartmentId)
                    ?? new DepartmentBudgetGuard { Id = cmd.DepartmentId };

        var view = await session.LoadAsync<DepartmentSpend>(cmd.DepartmentId);
        var budget = view?.Budget ?? 0m;
        var committed = view?.Committed ?? 0m;

        if (afterRead is not null) await afterRead();

        if (committed + cmd.Amount > budget) return CommitOutcome.BudgetExceeded;

        session.Events.Append(cmd.ProjectId, new SpendCommitted(cmd.ProjectId, cmd.DepartmentId, cmd.Amount));

        // UpdateRevision, NOT Store, AND THE +1 IS THE WHOLE MECHANISM.
        //
        // concurrency.md says Store() on an IRevisioned document "is essentially UpdateRevision(entity,
        // entity.Version)" — it passes the version it ALREADY HAS. The enforcing rule on the next page is
        // that a revision is "rejected with a ConcurrencyException ... if the version in the database is
        // equal or greater than the supplied revision", so a writer supplying its own current version is
        // asserting something already true and no two writers can ever disagree. That is why the interface
        // alone, the pre-created row and UseNumericRevisions(true) all failed to bite: none of them changes
        // WHICH number Store() supplies.
        //
        // Supplying Version + 1 makes the two contenders claim the same next revision. Both read N, both
        // claim N+1; the first commits and the row becomes N+1; the second is rejected because N+1 >= N+1.
        session.UpdateRevision(guard, guard.Version + 1);

        try
        {
            await session.SaveChangesAsync();
            return CommitOutcome.Committed;
        }
        // BOTH exceptions live in JasperFx, not Marten.Exceptions, as of Marten 9 — same move as
        // IRevisioned, same silence in the docs, same .xml grep to find them.
        catch (JasperFx.ConcurrencyException)
        {
            // Somebody else moved the guard between our read and our commit.
            return CommitOutcome.Conflict;
        }
        catch (JasperFx.DocumentAlreadyExistsException)
        {
            return CommitOutcome.Conflict;
        }
    }

    /// <summary>
    /// ARM 2 — A RESERVATION ROW, GUARDED BY A UNIQUE INDEX.
    ///
    /// The claim is not "I am updating the department" but "I am taking commit number N of this
    /// department". Two writers that read the same state compute the SAME next sequence, so both try to
    /// insert (department, N) and the unique index rejects one. The predicate becomes a write conflict
    /// again, this time as a uniqueness violation on an INSERT.
    ///
    /// HOW IT DIFFERS FROM ARM 1, which is the only reason to have both:
    ///   - it leaves an audit row per commit, so "who claimed sequence 7" is answerable afterwards
    ///   - it never UPDATEs a shared row, so nothing serialises on one hot row's lock
    ///   - the table grows without bound and nothing prunes it, which arm 1's single row never does
    ///   - the sequence must be COUNTED, and that count is O(rows) — the real cost, and the reason this
    ///     is the least attractive of the four despite working
    /// </summary>
    public static async Task<CommitOutcome> ReservationRow(
        IDocumentStore store, CommitSpend cmd, Func<Task>? afterRead = null)
    {
        await using var session = store.LightweightSession();

        // The sequence this attempt will claim. Derived from state, exactly like the budget check — which
        // is what makes two racing writers derive the SAME number and collide.
        var taken = await session.Query<BudgetReservation>()
            .CountAsync(r => r.DepartmentId == cmd.DepartmentId);

        var view = await session.LoadAsync<DepartmentSpend>(cmd.DepartmentId);
        var budget = view?.Budget ?? 0m;
        var committed = view?.Committed ?? 0m;

        if (afterRead is not null) await afterRead();

        if (committed + cmd.Amount > budget) return CommitOutcome.BudgetExceeded;

        session.Events.Append(cmd.ProjectId, new SpendCommitted(cmd.ProjectId, cmd.DepartmentId, cmd.Amount));

        // Insert, NOT Store. Store() is an upsert and would quietly overwrite the row the other writer
        // just inserted instead of colliding with it — the same trap that made arm 1's guard useless.
        session.Insert(new BudgetReservation
        {
            Id = Guid.NewGuid(),
            DepartmentId = cmd.DepartmentId,
            Sequence = taken + 1,
            Amount = cmd.Amount,
        });

        try
        {
            await session.SaveChangesAsync();
            return CommitOutcome.Committed;
        }
        catch (Exception ex) when (IsUniqueViolation(ex))
        {
            return CommitOutcome.Conflict;
        }
    }

    /// <summary>
    /// A unique-index violation arrives as Postgres SQLSTATE 23505, wrapped by Marten in its own command
    /// exception — so the type to catch is not stable but the SQLSTATE is. Walking the inner chain is
    /// deliberate: catching MartenCommandException alone would also swallow every OTHER database error as
    /// a "conflict", which would make this arm look like it works no matter what went wrong.
    /// </summary>
    private static bool IsUniqueViolation(Exception? ex)
    {
        for (; ex is not null; ex = ex.InnerException)
            if (ex is Npgsql.PostgresException { SqlState: "23505" }) return true;
        return false;
    }

    /// <summary>
    /// ARM 3 — A POSTGRES ADVISORY LOCK. SERIALISATION, NOT A CONFLICT.
    ///
    /// The other three arms all let both writers run and then refuse one. This one stops the second
    /// writer at the door, so it reads state the first has already committed and is then refused by the
    /// ORDINARY BUDGET RULE. That is the visible difference in the tests: the loser comes back
    /// BudgetExceeded, never Conflict, and no caller ever has to retry.
    ///
    /// THE LOCK MUST BE TAKEN BEFORE THE READ, which is the whole difficulty. Marten's QueueSqlCommand
    /// runs at SaveChangesAsync time — far too late, since the damage is a stale read. So this arm owns
    /// its own connection and transaction, takes pg_advisory_xact_lock on it, and only then hands the
    /// transaction to Marten via SessionOptions.ForTransaction. That overload explicitly does "not allow
    /// the session to own the transaction boundaries", so the commit below is ours to make and the lock
    /// is released by the commit or rollback rather than by anything we remember to write.
    ///
    /// COST: every commit in a department is serialised, including the ones that would never have
    /// conflicted, and a held lock blocks rather than fails — so a slow transaction becomes everyone
    /// else's latency. Arms 1, 2 and 4 degrade into retries under contention; this one degrades into
    /// waiting.
    /// </summary>
    /// <param name="afterRead">
    /// Accepted for symmetry with the other arms, and THE TESTS DELIBERATELY PASS NULL. A read-barrier
    /// cannot work here: writer A would hold the lock while waiting for writer B to read, and writer B
    /// cannot read until A releases the lock — so the barrier deadlocks against the very mechanism it is
    /// trying to observe. A mechanism that serialises before the read is not testable by forcing two
    /// simultaneous reads, because preventing them is what it does.
    /// </param>
    public static async Task<CommitOutcome> AdvisoryLock(
        IDocumentStore store, string connectionString, CommitSpend cmd, Func<Task>? afterRead = null)
    {
        await using var conn = new Npgsql.NpgsqlConnection(connectionString);
        await conn.OpenAsync();
        await using var tx = await conn.BeginTransactionAsync();

        await using (var lockCmd = new Npgsql.NpgsqlCommand("select pg_advisory_xact_lock(@key)", conn, tx))
        {
            lockCmd.Parameters.AddWithValue("key", AdvisoryKeyFor(cmd.DepartmentId));
            await lockCmd.ExecuteNonQueryAsync();
        }

        // Marten.Services.SessionOptions, NOT Marten.SessionOptions. documents/sessions.md writes it bare
        // as SessionOptions.ForTransaction(transaction) and names no namespace — and with `using Marten;`
        // in scope the name RESOLVES to a different type, so the failure is CS0117 "does not contain a
        // definition for ForTransaction" rather than an honest "type not found". That reads like a version
        // problem and is not one. Fifth entry in this folder's documented-with-no-namespace list; found by
        // grepping Marten.xml, which is the kit's prescribed tiebreaker.
        await using var session = store.LightweightSession(Marten.Services.SessionOptions.ForTransaction(tx));

        var view = await session.LoadAsync<DepartmentSpend>(cmd.DepartmentId);
        var budget = view?.Budget ?? 0m;
        var committed = view?.Committed ?? 0m;

        if (afterRead is not null) await afterRead();

        if (committed + cmd.Amount > budget)
        {
            // Rollback rather than just returning: the lock is transaction-scoped, so ending the
            // transaction is what lets the next writer in. Falling out of scope would work via dispose,
            // but making the release explicit is the point of the arm.
            await tx.RollbackAsync();
            return CommitOutcome.BudgetExceeded;
        }

        session.Events.Append(cmd.ProjectId, new SpendCommitted(cmd.ProjectId, cmd.DepartmentId, cmd.Amount));

        // SaveChangesAsync does NOT commit here — ForTransaction hands boundary ownership to us.
        await session.SaveChangesAsync();
        await tx.CommitAsync();
        return CommitOutcome.Committed;
    }

    /// <summary>
    /// Advisory locks are keyed by a bigint, and a Guid does not fit in one. Folding the department's
    /// 16 bytes to 8 means two departments could in principle share a lock key — which costs throughput
    /// and never correctness, since a false SHARING only over-serialises. A false SPLIT would be the
    /// dangerous direction, and hashing cannot produce one.
    /// </summary>
    private static long AdvisoryKeyFor(Guid departmentId)
    {
        Span<byte> bytes = stackalloc byte[16];
        departmentId.TryWriteBytes(bytes);
        return BitConverter.ToInt64(bytes[..8]) ^ BitConverter.ToInt64(bytes[8..]);
    }

    /// <summary>
    /// ARM 4 — DCB. The boundary is the tag query, not a stream.
    ///
    /// FetchForWritingByTags folds every event carrying this department's tag — across all its project
    /// streams — and records the tag's version. At SaveChangesAsync Marten re-checks that version, so a
    /// second writer that read the same state and appends to a DIFFERENT project stream still collides,
    /// on the tag row rather than on a stream.
    ///
    /// The event is appended to OUR OWN project stream, not routed by the tag: the model says a
    /// commitment belongs to a project's stream, and the tag is a boundary marker, not a stream key.
    /// The docs are explicit that a plain tagged append still bumps the version — "every save that
    /// appends a tagged event, boundary or otherwise, also queues a producer-side bump against the same
    /// row" — which is what makes this safe to combine with our own stream layout.
    /// </summary>
    public static async Task<CommitOutcome> Dcb(
        IDocumentStore store, CommitSpend cmd, decimal budget, Func<Task>? afterRead = null)
    {
        await using var session = store.LightweightSession();

        var query = new EventTagQuery().Or<DepartmentTag>(new DepartmentTag(cmd.DepartmentId));
        var boundary = await session.Events.FetchForWritingByTags<DepartmentBoundary>(query);
        var committed = boundary.Aggregate?.Committed ?? 0m;

        if (afterRead is not null) await afterRead();

        if (committed + cmd.Amount > budget) return CommitOutcome.BudgetExceeded;

        var e = session.Events.BuildEvent(new SpendCommitted(cmd.ProjectId, cmd.DepartmentId, cmd.Amount));
        e.WithTag(new DepartmentTag(cmd.DepartmentId));
        session.Events.Append(cmd.ProjectId, e);

        try
        {
            await session.SaveChangesAsync();
            return CommitOutcome.Committed;
        }
        catch (DcbConcurrencyException)
        {
            // Both writers found no guard and both tried to INSERT it. Same race, different Postgres
            // error — a primary key violation rather than a version mismatch — and the same verdict.
            return CommitOutcome.Conflict;
        }
    }
}
