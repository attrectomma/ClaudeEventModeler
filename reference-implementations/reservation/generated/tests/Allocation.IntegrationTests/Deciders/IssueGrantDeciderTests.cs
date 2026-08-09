// Hand-written. No container, no host, no database.
#nullable enable

using Marten.Events;
using Allocation.Contracts;
using Allocation.Slices.Allocation;
using Shouldly;
using Xunit;

namespace Allocation.IntegrationTests.Deciders;

/// <summary>
/// THE MULTI-STREAM DECIDER, UNIT-TESTED — which needs <c>StubEventStream&lt;T&gt;</c>, a type Marten ships
/// in <c>Marten.Events</c> for exactly this and which the kit had never used. The Wolverine docs' own
/// money-transfer example is tested this way, and it is the concrete answer to the book's complaint that a
/// non-pure handler forces you to reach for a mocking framework: there is no mock here, only a fake stream
/// that records what was appended.
///
/// <c>issue-grant</c> is NOT pure — it calls <see cref="IGrantExecutor"/>, which is the actual work and
/// cannot be hoisted above the decision because it must not run unless the preconditions hold. That single
/// dependency is a hand-written stub of four lines. Every PERSISTENCE dependency is gone, which is the part
/// the A-Frame is for.
/// </summary>
public sealed class IssueGrantDeciderTests
{
    private static readonly Guid Pool = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid Grant = Guid.Parse("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    private static readonly Guid Other = Guid.Parse("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");

    private sealed class Executor(bool accepts, string reason = "TheWorkRefused") : IGrantExecutor
    {
        public int Calls { get; private set; }

        public Task<GrantVerdict> Execute(Guid grantId, Guid poolId, int slotNumber, CancellationToken ct)
        {
            Calls++;
            return Task.FromResult(accepts ? GrantVerdict.Yes : GrantVerdict.No(reason));
        }
    }

    private static StubEventStream<IssueGrantState> GrantStream(IssueGrantState? current = null) =>
        // Key, not Id: IEventStream.Id is "the Guid identity of the stream, or Guid.Empty when the stream is
        // keyed by string", and this store is AsString. The docs' own unit-test example writes `Id = Guid.NewGuid()`
        // and `.Events`, which fits neither a string-keyed store nor this Marten version.
        new(current!) { Key = Grant.ToString() };

    private static ReserveSlotState HeldBy(Guid grantId) => new() { Held = true, GrantId = grantId };

    private static Task<SliceOutcome> Run(
        StubEventStream<IssueGrantState> grant, ReserveSlotState? slot, Executor executor) =>
        IssueGrantHandler.Handle(
            new IssueGrant(Grant, Pool, 1), grant, slot, executor,
            Microsoft.Extensions.Logging.Abstractions.NullLogger.Instance, CancellationToken.None);

    [Fact]
    public async Task a_held_slot_is_executed_into_a_grant()
    {
        var stream = GrantStream();
        var executor = new Executor(accepts: true);

        (await Run(stream, HeldBy(Grant), executor)).Accepted.ShouldBeTrue();

        stream.EventsAppended.ShouldHaveSingleItem().ShouldBeOfType<GrantIssued>().SlotNumber.ShouldBe(1);
        executor.Calls.ShouldBe(1);
    }

    [Fact]
    public async Task a_refusal_from_the_work_is_recorded_as_a_fact()
    {
        var stream = GrantStream();

        (await Run(stream, HeldBy(Grant), new Executor(accepts: false, "PartnerDeclined"))).Accepted
            .ShouldBeTrue("the command was legal and the decider did its job; the WORK said no");

        stream.EventsAppended.ShouldHaveSingleItem().ShouldBeOfType<GrantRefused>().Reason.ShouldBe("PartnerDeclined");
    }

    /// <summary>
    /// THE ASSERTION THAT MATTERS AND THAT NO INTEGRATION TEST MAKES: a grant already decided must not call
    /// the executor again. A second <c>GrantIssued</c> would be visible in the store, but a second CALL to
    /// the work is invisible there — and the work is the thing that cannot be undone.
    /// </summary>
    [Fact]
    public async Task an_already_decided_grant_does_not_call_the_work_again()
    {
        var executor = new Executor(accepts: true);
        var stream = GrantStream(new IssueGrantState { Decided = true });

        var outcome = await Run(stream, HeldBy(Grant), executor);

        outcome.Accepted.ShouldBeFalse();
        outcome.Error.ShouldBe(IssueGrantHandler.AlreadyIssued);
        stream.EventsAppended.ShouldBeEmpty();
        executor.Calls.ShouldBe(0);
    }

    [Fact]
    public async Task a_slot_nobody_holds_is_not_executed()
    {
        var executor = new Executor(accepts: true);
        var stream = GrantStream();

        var outcome = await Run(stream, null, executor);

        outcome.Error.ShouldBe(IssueGrantHandler.SlotNotHeld);
        stream.EventsAppended.ShouldBeEmpty();
        executor.Calls.ShouldBe(0);
    }

    /// <summary>A slot held by a DIFFERENT grant — the late-arriving execution. Same refusal, and again the
    /// work must not run.</summary>
    [Fact]
    public async Task a_slot_held_by_another_grant_is_not_executed()
    {
        var executor = new Executor(accepts: true);
        var stream = GrantStream();

        (await Run(stream, HeldBy(Other), executor)).Error.ShouldBe(IssueGrantHandler.SlotNotHeld);
        executor.Calls.ShouldBe(0);
    }

    /// <summary>The two key members this handler's middleware resolves. If either stops agreeing with the
    /// state type that composes it, [WriteAggregate] addresses the wrong stream — and every integration
    /// test would still pass, because they would all be wrong in the same direction.</summary>
    [Fact]
    public void the_commands_stream_keys_match_the_states()
    {
        var command = new IssueGrant(Grant, Pool, 1);
        command.StreamKey.ShouldBe(IssueGrantState.StreamKey(Grant.ToString()));
        command.SlotStreamKey.ShouldBe(ReserveSlotState.StreamKey(Pool, 1));
    }
}
