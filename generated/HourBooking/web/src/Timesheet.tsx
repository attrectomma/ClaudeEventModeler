// A port of designs/hour-booking/timesheet.html, not a new design.
//
// The markup and class names are the design's; tokens.css is copied verbatim and unedited. The
// data-em attributes come across too, so `node tools/design.mjs check diagrams/hour-booking/` keeps
// this page honest against the model exactly as it kept the static page honest.
//
// screen="timesheet" appears in three slices — book-hours, correct-hours, remove-booking. All three
// are now in-progress, so all three affordances on this screen are live. Nothing here is disabled for
// "not built yet" any more; the only disabling left is domain truth (a closed month) or a request in
// flight.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  bookHours,
  correctHours,
  getProjects,
  getTimesheet,
  removeBooking,
  type Project,
  type Rejection,
  type Timesheet as Sheet,
  type TimesheetLine,
} from "./api";
import "./tokens.css";

const EMPLOYEE_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const MONTH = "2026-08";
const DAILY_CAP = 18;

const day = (iso: string) =>
  new Date(iso).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });

export default function Timesheet() {
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [rejection, setRejection] = useState<Rejection | null>(null);
  const [busy, setBusy] = useState(false);
  // Which row's removal is in flight. A bookingId rather than a boolean, so the pending label lands on
  // the button that was actually pressed.
  const [removing, setRemoving] = useState<string | null>(null);

  // One form, two modes — which IS the domain fact. "There may be only one HoursBooked per
  // day+project, so booking again is a Correction", so the screen must say which action it offers.
  const [correcting, setCorrecting] = useState<TimesheetLine | null>(null);
  const [date, setDate] = useState("2026-08-05");
  const [projectId, setProjectId] = useState("");
  const [hours, setHours] = useState("8");
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    const [s, p] = await Promise.all([getTimesheet(EMPLOYEE_ID, MONTH), getProjects(EMPLOYEE_ID)]);
    setSheet(s);
    setProjects(p);
    setProjectId((current) => current || p.find((x) => !x.left)?.projectId || "");
  }, []);

  useEffect(() => void load(), [load]);

  const nameOf = useMemo(
    () => (id: string) => projects.find((p) => p.projectId === id)?.projectName ?? id,
    [projects],
  );

  const monthTotal = useMemo(
    () => (sheet?.lines ?? []).reduce((sum, l) => sum + l.hours, 0),
    [sheet],
  );

  const editable = sheet?.monthStatus === "Open" || sheet?.monthStatus === "Submitted";

  // One request at a time. The three affordances share one `rejection` slot, so letting two overlap
  // would leave the page showing a rule name without saying which action it refused.
  const pending = busy || removing !== null;

  function startCorrecting(line: TimesheetLine) {
    setCorrecting(line);
    setRejection(null);
    setDate(line.date);
    setProjectId(line.projectId);
    setHours(String(line.hours));
    setNote(line.note ?? "");
  }

  function cancelCorrecting() {
    setCorrecting(null);
    setRejection(null);
    setNote("");
  }

  // The third affordance, and the only one that sends nothing: the route carries all three of
  // RemoveBooking's fields. `MyTimesheet` is an inline projection, so the reload below already sees the
  // row gone the moment the 204 returns — no polling, no optimistic delete.
  async function remove(line: TimesheetLine) {
    setRemoving(line.bookingId);
    setRejection(null);

    const problem = await removeBooking(EMPLOYEE_ID, MONTH, line.bookingId);
    setRejection(problem);

    // Removal is not idempotent, so `BookingNotFound` means this page was stale — somebody else took
    // the row, or this tab has been open across it. Reloading is the answer either way, which is why
    // it runs whether the removal was accepted or refused.
    if (correcting?.bookingId === line.bookingId) setCorrecting(null);
    await load();
    setRemoving(null);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setRejection(null);

    // A correction takes no date and no project: the booking it names already has both.
    const problem = correcting
      ? await correctHours(EMPLOYEE_ID, MONTH, {
          bookingId: correcting.bookingId,
          employeeId: EMPLOYEE_ID,
          month: MONTH,
          hours: Number(hours),
          note: note.trim() === "" ? null : note,
        })
      : await bookHours(EMPLOYEE_ID, MONTH, {
          bookingId: crypto.randomUUID(),
          employeeId: EMPLOYEE_ID,
          month: MONTH,
          projectId,
          date,
          hours: Number(hours),
          note: note.trim() === "" ? null : note,
        });

    setRejection(problem);
    if (!problem) {
      setNote("");
      setCorrecting(null);
    }
    await load();
    setBusy(false);
  }

  if (!sheet) {
    return (
      <main>
        <h1>Timesheet</h1>
        <p className="summary">
          No booking month has been started for {MONTH}. That is the <code>start-month</code>{" "}
          automation&rsquo;s job, and it is not built yet.
        </p>
      </main>
    );
  }

  const sorted = [...sheet.lines].sort((a, b) => a.date.localeCompare(b.date));

  return (
    <main>
      <header>
        <h1>Timesheet</h1>
        <span className="who">
          <span data-em="employeeId">Ada Lovelace</span> &middot;{" "}
          <span data-em="month">{sheet.month}</span>
        </span>
        <span
          className="status"
          data-em="monthStatus"
          data-state={sheet.monthStatus === "Closed" ? "closed" : "open"}
        >
          {sheet.monthStatus}
        </span>
      </header>

      <p className="summary">
        <strong data-em="dayTotal">{sorted[0]?.dayTotal ?? 0}</strong> hours booked on{" "}
        {sorted[0] ? day(sorted[0].date) : "the first booked day"}. The daily cap is {DAILY_CAP}.
      </p>

      {rejection && (
        <p className="summary" role="alert" style={{ borderLeft: "3px solid var(--warn)", paddingLeft: 10 }}>
          <strong>{rejection.title}</strong> &mdash; {rejection.detail}
          {rejection.title === "BookingNotFound" && " The list below has been reloaded."}
        </p>
      )}

      <table>
        {/* The design's caption. It said "correct or remove" all along; now both are true. */}
        <caption>Bookings this month. Hover a row to correct or remove it.</caption>
        <thead>
          <tr>
            <th scope="col">Date</th>
            <th scope="col">Project</th>
            <th scope="col" className="num">Hours</th>
            <th scope="col">Note</th>
            <th scope="col" className="num">Day total</th>
            <th scope="col"><span className="visually-hidden">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((l) => (
            <tr key={l.bookingId} data-em="bookingId">
              <td className="day" data-label="Date">
                <span data-em="date">{day(l.date)}</span>
              </td>
              <td data-label="Project" data-em="projectId">
                <span data-em="projectName">{nameOf(l.projectId)}</span>
              </td>
              <td className="num" data-label="Hours">
                <span
                  className="measure"
                  data-over={l.dayTotal > DAILY_CAP ? "true" : undefined}
                  style={{ ["--fill" as string]: `${Math.min(100, (l.hours / DAILY_CAP) * 100)}%` }}
                >
                  <span data-em="hours">{l.hours}</span>
                </span>
              </td>
              <td className="note" data-label="Note"><span data-em="note">{l.note ?? ""}</span></td>
              <td className="num" data-label="Day total">{l.dayTotal}</td>
              <td className="actions">
                <button className="link" data-em-action="CorrectHours" data-em-input="bookingId"
                        onClick={() => startCorrecting(l)}
                        disabled={!editable || pending || correcting?.bookingId === l.bookingId}>Correct</button>
                <button className="link danger" data-em-action="RemoveBooking" data-em-input="bookingId"
                        onClick={() => void remove(l)}
                        disabled={!editable || pending}
                        title={editable ? undefined : "This month is closed, so it can no longer be edited."}>
                  {removing === l.bookingId ? "Removing…" : "Remove"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td className="label" colSpan={2}>Booked in {sheet.month}</td>
            <td className="num">{monthTotal}</td>
            <td colSpan={3}></td>
          </tr>
        </tfoot>
      </table>

      <form onSubmit={submit}>
        <h2>{correcting ? `Correct ${day(correcting.date)} · ${nameOf(correcting.projectId)}` : "Book hours"}</h2>
        <div>
          <label htmlFor="f-date">Date</label>
          {/* A correction cannot move the day or the project — it names a booking that has both. */}
          <input id="f-date" type="date" value={date} data-em-input="date"
                 disabled={correcting !== null}
                 onChange={(e) => setDate(e.target.value)} />
        </div>
        <div>
          <label htmlFor="f-project">Project</label>
          <select id="f-project" value={projectId} data-em-input="projectId"
                  disabled={correcting !== null}
                  onChange={(e) => setProjectId(e.target.value)}>
            {projects.map((p) => (
              <option key={p.projectId} value={p.projectId}>
                {p.projectName}{p.left ? " (left)" : ""}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="f-hours">Hours</label>
          <input id="f-hours" className="num" value={hours} inputMode="decimal" data-em-input="hours"
                 onChange={(e) => setHours(e.target.value)} />
        </div>
        <div className="field-note">
          <label htmlFor="f-note">Note <span style={{ textTransform: "none" }}>(optional)</span></label>
          <input id="f-note" value={note} data-em-input="note" onChange={(e) => setNote(e.target.value)} />
        </div>
        {correcting ? (
          <>
            <button className="primary" data-em-action="CorrectHours" disabled={pending || !editable}>
              {busy ? "Saving…" : "Save correction"}
            </button>
            <button type="button" className="link" onClick={cancelCorrecting} disabled={pending}>
              Cancel
            </button>
          </>
        ) : (
          <button className="primary" data-em-action="BookHours" disabled={pending || !editable}>
            {busy ? "Booking…" : "Book hours"}
          </button>
        )}
        <p className="hint">
          Whole or half hours only, never zero.{" "}
          {correcting
            ? "A correction carries the new total for the day, not the difference."
            : "Booking the same day and project again is a correction, not a second booking."}
          {!editable && " This month is closed, so it can no longer be edited."}
        </p>
      </form>
    </main>
  );
}
