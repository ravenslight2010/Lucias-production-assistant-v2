# Facility run permissions

Run permissions are based on the user's current `facility_members.role` row.
The API looks up membership from PostgreSQL for each protected run request;
facility roles are not stored in V2 session claims.

| Facility role | Create a planned run | Start, pause, or resume | Complete a run |
| --- | --- | --- | --- |
| Owner | Allowed | Allowed | Allowed |
| Manager | Allowed | Allowed | Allowed |
| Operator | Denied | Allowed | Denied |

Operators can carry out run-floor operations, but creating work or recording
that production is complete requires an owner or manager. A changed or removed
membership takes effect on the next request made with the same signed-in
session.
