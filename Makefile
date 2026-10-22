.PHONY: check image push

# The image's tag: bump it for every push, never overwrite a pushed tag.
# 0.1.0: the webhook ingress (nothing pushed yet).
VERSION ?= 0.1.0
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
