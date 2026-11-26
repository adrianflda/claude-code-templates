---
name: gcp-pubsub
description: Designing Google Cloud Pub/Sub topics and subscriptions (pull, push or export, acknowledgment deadline, retries, dead-letter topics, ordering, filters). Use when code or infrastructure on Google Cloud publishes or consumes Pub/Sub messages.
disable-model-invocation: true
---

# Pub/Sub

Numbers below were read from Google's subscription pages on 2026-11-25. Exactly-once delivery,
the IAM roles for dead-lettering and client-library settings are not covered here: read their
pages before using them (https://docs.cloud.google.com/pubsub/docs).

## Which subscription type

| Type | Choose it when |
|---|---|
| Pull | High volume, or no public HTTPS endpoint. The subscriber controls the rate and can extend the acknowledgment deadline, so processing can take long. |
| Push | The consumer is an HTTPS endpoint (Cloud Run, a webhook), or credentials and client libraries cannot be set up. One message per request; the endpoint signals overload with an HTTP error. |
| Export (BigQuery, Cloud Storage) | Messages go to storage with no processing in between. Avoids running a pipeline. |

## Subscription settings

| Setting | Default | Range |
|---|---|---|
| Acknowledgment deadline | 10 s | 10 s to 600 s |
| Message retention | 7 days | 10 minutes to 31 days |
| Expiration (no activity) | 31 days | 1 day minimum, or never |
| Retry policy | Retry immediately | or exponential backoff, at most 600 s |
| Dead-letter delivery attempts | 5 | 5 to 100 |

- A **filter** cannot be changed or removed after the subscription is created. A wrong filter
  means a new subscription.
- **Ordering** holds only for messages with the same ordering key in the same region, and only
  if the publisher sets the key.
- **Retaining acknowledged messages** allows a replay and adds storage cost.

## Rules for a consumer

- **Assume duplicates.** Make the handler idempotent: key the work on the message ID or on a
  business ID carried in the message.
- **Acknowledge after the work is done**, never on receipt. If the work can outlast the deadline,
  extend it (pull) or hand off to a queue and answer (push).
- **Set exponential backoff** for a consumer that calls something that can be down. The default
  retries immediately and multiplies the load on a failing dependency.
- **Attach a dead-letter topic** with its own subscription and an alert, so a message that always
  fails stops blocking and is seen. A dead-letter topic nobody reads loses messages when its
  retention ends.
- **A failing message under an ordering key holds back the ones behind it.** Use ordering only
  when the order matters, with narrow keys.
- **Authenticate push requests** (the endpoint verifies the token Pub/Sub attaches) and keep the
  endpoint private where the platform allows it.
- **Set the expiration to never** for a production subscription that can be idle for a month.

## Before a command that changes something

Deleting a subscription drops its unacknowledged messages, and seeking or purging changes what
consumers receive: show the command and ask first.
