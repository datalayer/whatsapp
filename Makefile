.PHONY: check image push

# The image's tag: bump it for every push, never overwrite a pushed tag.
# 0.1.0: the webhook ingress, install, removal, the 1:1 turn, deliveries,
#        approvals and the window keeper (whatsapp 9d9cba2, agent-runtimes 1.5.84).
# 0.1.0: pushed 22 October 2026 (sha256:83ce234dabaa…), pinned in up.sh datalayer_whatsapp.
# 0.1.1: install without Meta's account and number in the signup message (debug_token), numbers
#        kept on the WhatsApp Business app (coexistence), the business's privacy page kept
#        (migration 005), unlink and forget naming what they leave (181c11a, 0cee3c0).
# 0.1.2: a refused install step logs which step and Meta's codes (c4672bd).
# 0.1.3: connect with the business's own Meta app (per-installation webhook, app secret kept),
#        a number already on the Cloud API not registered again (4c711a6, a1ee140).
# 0.1.4: one way to connect a number, each application's own Meta app; Datalayer has no Meta app
#        (no app id, secret or verify token; a chart-generated verify secret) (3eafc54).
# 0.1.5: groups (create, invite link, on/off, answer when named) and the Official Business Account status
#        and request from the card; migration 008 (1b5b911).
VERSION ?= 0.1.5
REGISTRY ?= $(DATALAYER_DOCKER_REGISTRY)
EXPORT := $(HOME)/.cache/whatsapp-export-$(shell git rev-parse --short HEAD)

# Built from a clean export of HEAD (git archive), never the working tree.
image:
	@test -n "$(REGISTRY)" || { echo "DATALAYER_DOCKER_REGISTRY is not set." >&2; exit 1; }
	@if docker manifest inspect $(REGISTRY)/whatsapp:$(VERSION) >/dev/null 2>&1; then \
		echo "whatsapp:$(VERSION) is already pushed: bump VERSION." >&2; exit 1; fi
	rm -rf $(EXPORT) && mkdir -p $(EXPORT)
	git archive HEAD | tar -x -C $(EXPORT)
	docker build -t $(REGISTRY)/whatsapp:$(VERSION) $(EXPORT)

push:
	docker push $(REGISTRY)/whatsapp:$(VERSION)
	docker manifest inspect $(REGISTRY)/whatsapp:$(VERSION) >/dev/null

check:
	npm run check
