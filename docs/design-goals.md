# Design goals

This file lists the four problems a stock demo fleet of chat agents had when a whole team tried to use it, each with the requirements a fix has to meet. The fleet runs on OpenClaw, an open-source server that hosts the agents, and fixing these problems is what makes it safe to share across a team.

## 1. The interface fell over past a few concurrent sessions

Rolling the fleet out to a whole go-to-market team, it did not hold up. Past a handful of simultaneous sessions, requests either failed outright or landed in a queue long enough that nobody waited for it, and a user could not work in more than one chat at a time. The target was around 50 people in the same window. The harness, which is the OpenClaw server and its default settings that run the agents, ran close to stock. Separately, some agent definitions called integrations one record at a time where the integration supports batching, which burned upstream rate limits faster than it needed to.

Requirements:

- hold 50 or more people in the same window without sessions failing or queueing indefinitely
- make behavior at capacity a decision, not a failure
- stop sessions accumulating indefinitely
- handle upstream rate limits, both the model provider and the tool APIs, deliberately
- not break agent behavior elsewhere in the repo

## 2. No per-user or per-agent permission model

Every agent had the same access to every integration, regardless of which agent it was or who was talking to it. Access was global and did not vary by context. One agent could write to Salesforce, which is fine for a known human doing a single-record write from this interface, but not for a bulk job and not when invoked from anywhere else.

Requirements:

- resolve permissions at user, agent and tool
- let the same agent carry different permission sets depending on how and where it was invoked
- scope write access more narrowly than read, including constraining the shape of a write rather than only allowing or denying it
- enforce somewhere an agent's instructions cannot override
- not require rewriting the whole policy to add an agent or an integration

Non-goal: authentication; the roster lives in `config/users.json`.

## 3. No PartnerStack integration

Partnerships wanted agent access to PartnerStack, which offers a public REST API and an MCP server. Its API is rate limited with a daily cap, its MCP docs are gated behind a request, and its rewards and transactions move real money to partners. The existing Salesforce integration is an OpenClaw plugin, an add-on package that gives agents tools, so a REST plugin follows the same pattern.

Requirements:

- make every change in PartnerStack attributable to the agent and to the user it acted for
- carry granular permissions consistent with the model above
- handle writes deliberately given what they touch

## 4. Memory was shared across users

The stock harness wrote memory to a file per agent and shared it across everyone using that agent. Users started cold every session, and anything an agent retained was visible to whoever used it next.

Requirements:

- persist memory across sessions, scoped to the individual user
- keep two people on the same agent separate, with no bleed either way
- keep memory from growing unbounded
- stay consistent with the permission model above

Non-goal: context compaction within a single session.
