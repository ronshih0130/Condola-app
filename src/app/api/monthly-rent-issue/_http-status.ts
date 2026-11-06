export function monthlyRentHttpStatus(status: string): number {
  switch (status) {
    case "rejected_disabled":
      return 403;
    case "rejected_invalid":
      return 400;
    case "rejected_conflict":
      return 409;
    case "unsupported":
      return 422;
    case "created":
    case "already_issued":
    case "replay":
      return 200;
    default:
      return 200;
  }
}
