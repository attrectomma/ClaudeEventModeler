// The API surface this screen needs, and nothing more.
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

export const getTimesheet = (employeeId: string, month: string) =>
  fetch(`/timesheet/${employeeId}/${month}`).then((r) =>
    r.status === 404 ? null : json<Timesheet>(r),
  );

export const getProjects = (employeeId: string) =>
  fetch(`/timesheet/${employeeId}/projects`).then(json<Project[]>);

export type BookHours = {
  bookingId: string;
  employeeId: string;
  month: string;
  projectId: string;
  date: string;
  hours: number;
  note: string | null;
};

/**
 * Returns null on success, or the rejected rule. Both the periphery validator and the decider answer
 * with ProblemDetails, so one shape covers HoursMustBeWholeOrHalf and DailyCapExceeded alike.
 */
export async function bookHours(
  employeeId: string,
  month: string,
  command: BookHours,
): Promise<Rejection | null> {
  const res = await fetch(`/timesheet/${employeeId}/${month}/bookings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(command),
  });
  if (res.status === 204) return null;

  // The rule name lands in DIFFERENT places depending on where the rule was enforced, which the
  // comment above used to claim it did not:
  //   periphery (FluentValidation middleware) -> { errors: { Hours: ["HoursMustBeWholeOrHalf"] } }
  //   the decider (our own ProblemDetails)    -> { title: "DailyCapExceeded", detail: "..." }
  // Found by calling the API, not by reading either library.
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
      : problem.detail ?? `The booking was refused (${res.status}).`,
  };
}
