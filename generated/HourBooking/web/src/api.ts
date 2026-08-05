// The API surface these screens need, and nothing more.
//
// Shapes mirror the model: MyTimesheet is one document per (employee, month) holding lines, and
// projectName lives on MyProjects because it was deliberately removed from MyTimesheet — the row it
// belongs to is created by a different event than the one carrying it. So the screen joins the two
// on projectId, which is why there are two GETs rather than one.

export type TimesheetLine = {
  bookingId: string;
  projectId: string;
  date: string;
  hours: number;
  note: string | null;
  dayTotal: number;
};

export type Timesheet = {
  id: string;
  employeeId: string;
  month: string;
  /** derived="monthStatus=BookingMonthStarted+MonthClosureSubmitted+MonthClosureRejected+MonthClosed" */
  monthStatus: "NotStarted" | "Open" | "Submitted" | "Rejected" | "Closed";
  lines: TimesheetLine[];
};

export type Project = {
  id: string;
  employeeId: string;
  projectId: string;
  projectName: string;
  /** EmployeeRemovedFromProject. Kept as a flag rather than a delete so a refusal can be explained. */
  left: boolean;
};

/** A rejected business rule. The rule's name is the machine-readable part, exactly as the GWT says. */
export type Rejection = { title: string; detail: string };

const json = async <T>(res: Response): Promise<T> => {
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as T;
};

/**
 * The rule name lands in DIFFERENT places depending on where the rule was enforced:
 *   periphery (FluentValidation middleware) -> { errors: { Hours: ["HoursMustBeWholeOrHalf"] } }
 *   the decider (our own ProblemDetails)    -> { title: "DailyCapExceeded", detail: "..." }
 * Found by calling the API, not by reading either library. Shared by both commands, which is what the
 * second slice made obvious.
 */
async function readRejection(res: Response): Promise<Rejection> {
  const problem = (await res.json().catch(() => ({}))) as {
    title?: string;
    detail?: string;
    errors?: Record<string, string[]>;
  };
  const fromValidator = Object.values(problem.errors ?? {}).flat()[0];
  return {
    title: fromValidator ?? problem.title ?? "Rejected",
    detail: fromValidator
      ? "The request itself was refused before any booking was read."
      : (problem.detail ?? `The request was refused (${res.status}).`),
  };
}

const post = async (url: string, body: unknown): Promise<Rejection | null> => {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.status === 204 ? null : readRejection(res);
};

const del = async (url: string): Promise<Rejection | null> => {
  const res = await fetch(url, { method: "DELETE" });
  return res.status === 204 ? null : readRejection(res);
};

// --- reads ----------------------------------------------------------------------------------------

export const getTimesheet = (employeeId: string, month: string) =>
  fetch(`/timesheet/${employeeId}/${month}`).then((r) =>
    r.status === 404 ? null : json<Timesheet>(r),
  );

export const getProjects = (employeeId: string) =>
  fetch(`/timesheet/${employeeId}/projects`).then(json<Project[]>);

// --- book-hours -----------------------------------------------------------------------------------

export type BookHours = {
  bookingId: string;
  employeeId: string;
  month: string;
  projectId: string;
  date: string;
  hours: number;
  note: string | null;
};

export const bookHours = (employeeId: string, month: string, command: BookHours) =>
  post(`/timesheet/${employeeId}/${month}/bookings`, command);

// --- correct-hours --------------------------------------------------------------------------------

export type CorrectHours = {
  bookingId: string;
  employeeId: string;
  month: string;
  hours: number;
  note: string | null;
};

/**
 * The second affordance of the SAME screen. A correction carries the new TOTAL for the day, never the
 * difference — the expert was explicit about that — so the form sends what the day should now read.
 * It takes no date or project: the booking it names already has both.
 */
export const correctHours = (employeeId: string, month: string, command: CorrectHours) =>
  post(
    `/timesheet/${employeeId}/${month}/bookings/${command.bookingId}/corrections`,
    command,
  );

// --- remove-booking -------------------------------------------------------------------------------

/**
 * The third affordance of the SAME screen, and the only one that sends no body: RemoveBooking's three
 * declared fields (bookingId, employeeId, month) ARE the route, so a body would state the same facts
 * twice. There is no validator on this route either, so a rejection only ever arrives in the
 * { title, detail } shape — readRejection handles both regardless.
 *
 * Deliberately NOT idempotent: a second DELETE is 400 BookingNotFound, not 204. That is a feature —
 * a screen offering a row that is no longer there is stale, and the user is told rather than shown a
 * silent success. BookingNotFound covers "already removed" and "never existed" alike; the stream
 * cannot tell them apart, so neither can this.
 */
export const removeBooking = (employeeId: string, month: string, bookingId: string) =>
  del(`/timesheet/${employeeId}/${month}/bookings/${bookingId}`);
