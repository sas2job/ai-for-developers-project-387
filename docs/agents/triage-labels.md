# Triage Labels

The skills speak in terms of canonical triage roles. This file maps the roles used in this repo to their issue tracker labels.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role, use the corresponding label string from this table. Roles without a row have no label in this repo.

Edit the "Label in our tracker" column to match whatever vocabulary you actually use.

## GitHub automation labels

| Label | Meaning |
| --- | --- |
| `agent:plan` | Request preparation of a specification and ticket proposal |
| `agent:implement` | Request implementation of the current human-approved plan |
| `agent:spec` | Published approved specification |
| `agent:ticket` | Published implementation ticket |
| `ready-for-agent` | Approved task available to an agent |
| `agent:audit` | Finding from a regular application health report |

The configured maintainer chooses audit findings labelled `needs-triage`. A plan label alone does not approve its implementation. See [the GitHub workflow](github-automation.md).
