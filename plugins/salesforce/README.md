# Salesforce

This plugin lets the agents of an OpenClaw fleet (OpenClaw is an open-source server that runs chat agents) list and read Salesforce accounts, and, when a role holds a grant, update one account or many. It runs against a short in-memory list of fake accounts, not a real Salesforce org, so it needs no key. It is for trying the permission guard in `plugins/policy-core` without touching real data.

## Build

```bash
npm install
npm run plugin:build
npm run plugin:validate
npm test
```
