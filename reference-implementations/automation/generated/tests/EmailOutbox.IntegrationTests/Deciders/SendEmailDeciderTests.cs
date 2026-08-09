// Hand-written. No container, no host, no database.
#nullable enable

using EmailOutbox.Contracts;
using EmailOutbox.Slices.EmailOutbox;
using Shouldly;
using Xunit;

namespace EmailOutbox.IntegrationTests.Deciders;

/// <summary>
/// <c>SendEmailHandler.Handle</c> is <c>(command, state) -&gt; (outcome, events)</c>, so there is nothing to
/// arrange but a record. These run with Docker stopped:
/// <c>dotnet test --filter "FullyQualifiedName~Deciders"</c>.
///
/// They do not replace <c>SendEmailTests</c>, which drives the same decider through the real bus against
/// real Postgres and is the only place a wrong stream key or a missing registration would show up. The
/// split is the point: these enumerate the DECISION cheaply, that one proves the wiring.
/// </summary>
public sealed class SendEmailDeciderTests
{
    private static readonly Guid Email = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static SendEmail Command => new(Email);

    [Fact]
    public void a_prepared_email_is_sent()
    {
        var (outcome, events) = SendEmailHandler.Handle(
            Command, new SendEmailState { Prepared = true });

        outcome.WasSent.ShouldBeTrue();
        var sent = events.ShouldHaveSingleItem().ShouldBeOfType<EmailSent>();
        sent.EmailId.ShouldBe(Email);
        sent.ProviderMessageId.ShouldNotBeNullOrWhiteSpace();
        outcome.ProviderMessageId.ShouldBe(sent.ProviderMessageId,
            "the id the trigger reads back must be the one that went into history");
    }

    /// <summary>A missing stream and a stream nobody prepared into are the same thing to this decider, and
    /// that equivalence is a decision worth pinning rather than a coincidence.</summary>
    [Fact]
    public void an_email_nobody_prepared_cannot_be_sent()
    {
        foreach (var state in new SendEmailState?[] { null, new SendEmailState() })
        {
            var (outcome, events) = SendEmailHandler.Handle(Command, state);
            outcome.WasSent.ShouldBeFalse();
            outcome.Rule.ShouldBe("NotPrepared");
            events.ShouldBeEmpty();
        }
    }

    /// <summary>
    /// THE LOAD-BEARING RULE OF THIS WHOLE FOLDER. Every wakeup mechanism here is at-least-once, so without
    /// it the four mechanisms would be four ways of sending duplicate email. The SEQUENTIAL duplicate is
    /// this; the simultaneous one is the stream's version, retried by the policy in Program.cs, which lands
    /// back on exactly this rule.
    /// </summary>
    [Fact]
    public void an_email_already_sent_is_not_sent_twice()
    {
        var (outcome, events) = SendEmailHandler.Handle(
            Command, new SendEmailState { Prepared = true, Sent = true });

        outcome.Rule.ShouldBe("AlreadySent");
        events.ShouldBeEmpty();
    }

    [Fact]
    public void the_commands_stream_key_is_the_email_streams_key()
        => Command.StreamKey.ShouldBe(SendEmailState.StreamKey(Email));
}
