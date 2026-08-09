// Hand-written. THE FIRST UNIT TESTS IN THIS KIT — no container, no host, no database.
#nullable enable

using Allocation.Contracts;
using Allocation.Slices.Allocation;
using Shouldly;
using Xunit;

namespace Allocation.IntegrationTests.Deciders;

/// <summary>
/// THE POINT OF THE A-FRAME SHAPE, AND THE KIT'S 140TH TEST — the first one that touches no infrastructure.
///
/// Until this file, every test in every reference implementation booted Testcontainers Postgres. That was
/// not a testing preference, it was a consequence: a decider that took <c>IDocumentSession</c> and called
/// <c>FetchForWriting</c> could not be tested any other way. Which is precisely what the book warns about —
///
///   > "the Command Handler is no longer 'pure' and gains unnecessary dependencies. This added dependency
///   >  complicates testing. To write effective tests, you'll need a mocking framework"
///   >                                                     — The little Eventmodeling Book, ch. 15
///
/// — except the kit paid the cost in containers rather than in mocks, which is slower and hides the same
/// design problem.
///
/// <c>ReleaseSlotHandler.Handle</c> is now <c>(command, state) -&gt; (outcome, events)</c>. There is nothing to
/// arrange but a record, and nothing to assert but the return value.
///
/// <code>dotnet test --filter "FullyQualifiedName~Deciders"</code> runs these with Docker stopped.
///
/// THEY DO NOT REPLACE THE GWT TESTS, and the split is worth stating. A GWT test proves the slice works
/// through the real API against real Postgres — that the middleware resolves the right stream, that the
/// projection updates, that the endpoint is reachable. These prove only the DECISION. Both are needed:
/// this file cannot see a wrong stream key, and ReleaseSlotTests cannot enumerate edge cases cheaply.
/// </summary>
public sealed class ReleaseSlotDeciderTests
{
    private static readonly Guid Pool = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid Grant = Guid.Parse("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    private static readonly Guid OtherGrant = Guid.Parse("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");

    private static ReleaseSlot Command(Guid? grantId = null) =>
        new(Pool, 3, grantId ?? Grant, "TheWorkRefused");

    private static ReleaseSlotState Held(Guid grantId) =>
        new() { Held = true, GrantId = grantId };

    [Fact]
    public void a_held_slot_is_given_back()
    {
        var (outcome, events) = ReleaseSlotHandler.Handle(Command(), Held(Grant));

        outcome.Accepted.ShouldBeTrue();
        var released = events.ShouldHaveSingleItem().ShouldBeOfType<SlotReleased>();
        released.SlotNumber.ShouldBe(3);
        released.GrantId.ShouldBe(Grant);
        released.Reason.ShouldBe("TheWorkRefused");
    }

    /// <summary>A stream that does not exist folds to null, and the decider owns that case rather than
    /// letting the framework answer 404 with no rule name in it.</summary>
    [Fact]
    public void a_slot_whose_stream_does_not_exist_is_refused()
    {
        var (outcome, events) = ReleaseSlotHandler.Handle(Command(), null);

        outcome.Accepted.ShouldBeFalse();
        outcome.Error.ShouldBe(ReleaseSlotHandler.AlreadyReleased);
        events.ShouldBeEmpty();
    }

    [Fact]
    public void a_slot_already_given_back_is_not_released_twice()
    {
        var (outcome, events) = ReleaseSlotHandler.Handle(Command(), new ReleaseSlotState { Held = false });

        outcome.Accepted.ShouldBeFalse();
        outcome.Error.ShouldBe(ReleaseSlotHandler.AlreadyReleased);
        events.ShouldBeEmpty();
    }

    /// <summary>
    /// THE ONE THAT WOULD BE EXPENSIVE TO SET UP THROUGH POSTGRES: the compensation arriving so late that
    /// the unit has been released AND re-reserved by somebody else. Through the API that needs three
    /// commands in the right order; here it is one line, which is the argument for this tier in miniature.
    /// </summary>
    [Fact]
    public void a_slot_re_reserved_by_a_later_grant_is_not_stolen_back()
    {
        var (outcome, events) = ReleaseSlotHandler.Handle(Command(), Held(OtherGrant));

        outcome.Accepted.ShouldBeFalse();
        outcome.Error.ShouldBe(ReleaseSlotHandler.NotHeldByThisGrant);
        events.ShouldBeEmpty();
    }

    /// <summary>The reason is carried through onto the event, not invented by the decider — so the row the
    /// trigger read is what ends up in history.</summary>
    [Fact]
    public void the_refusal_reason_is_carried_onto_the_event()
    {
        var (_, events) = ReleaseSlotHandler.Handle(
            new ReleaseSlot(Pool, 3, Grant, "PartnerDeclined"), Held(Grant));

        events.ShouldHaveSingleItem().ShouldBeOfType<SlotReleased>().Reason.ShouldBe("PartnerDeclined");
    }

    /// <summary>
    /// The computed member the whole conversion rests on. If this ever stops matching what
    /// ReleaseSlotState.StreamKey produces, [WriteAggregate] silently addresses a different stream — which
    /// would be a wrong-stream bug that every integration test would still pass, because they would all be
    /// wrong in the same direction.
    /// </summary>
    [Fact]
    public void the_commands_stream_key_is_the_slot_streams_key()
    {
        Command().StreamKey.ShouldBe(ReleaseSlotState.StreamKey(Pool, 3));
        Command().StreamKey.ShouldBe($"slot:{Pool}:3");
    }
}
