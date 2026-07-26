# Legal notes

This is practical guidance, not legal advice. IPTV law varies a great deal by
country, and if you are deploying this publicly you should satisfy yourself that
what you are indexing is lawful where you operate.

## What this project does and does not do

**Does:** collect stream URLs that are already publicly listed, check whether
they respond, describe them, and publish that description as data.

**Does not:** host, transcode, proxy, re-encode or rebroadcast any video. No
video traffic passes through this project or its deployment. It also ships no
mechanism for accessing paid, encrypted or credential-protected services, and
adding one is out of scope.

The closest analogy is a search engine index or a link directory: it points at
things that are already public and says something useful about them.

## What to keep in mind

**Publicly reachable is not the same as licensed for redistribution.** A stream
being fetchable does not mean its operator intended it to be listed. When adding
sources, prefer:

- official free-to-air and public broadcaster feeds
- FAST services that publish their own playlists
- lists that state a licence permitting redistribution

Avoid anything that is obviously a leak of a paid service, that requires
credentials, or that is distributed as a subscription line. Sources like that
will be removed from this repository when found.

**The upstream blocklist is honoured.** `aggregate.respect_blocklist` defaults
to `true`, so channels flagged upstream for DMCA or NSFW reasons are dropped.
Leave it on unless you have a specific reason and have thought it through.

**NSFW channels are excluded by default** via `aggregate.exclude_nsfw`. If you
turn that off, the responsibility for age-gating whatever you publish is yours.

**Automatic discovery proposes, it does not merge.** The discovery workflow
opens a pull request. Review what it found before merging — that review step is
where a human decides whether a source is appropriate, and removing it turns a
curated index into an unattended scraper.

## Takedown requests

If you operate a stream indexed by a deployment of this project and want it
removed, open an issue on that deployment's repository with the URL or channel
id. Removals take effect on the next sync.

For the upstream database, requests go to
[iptv-org/database](https://github.com/iptv-org/database), and are picked up
here automatically through the blocklist.

## Licence

The code is MIT. Channel metadata comes from
[iptv-org](https://github.com/iptv-org/database) under its own terms. Individual
streams are governed by whatever terms their operators apply — this project
makes no claim over them and grants no rights to them.
