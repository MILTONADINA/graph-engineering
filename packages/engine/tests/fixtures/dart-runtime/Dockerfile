# syntax=docker/dockerfile:1.7
# Build as graph-dart-analyzer:local for linux/amd64. The source image is the
# official Dart 3.13.3 amd64 manifest, not a mutable tag. Pre-pull it before
# an offline build; neither stage downloads SDK content.
FROM --platform=linux/amd64 dart@sha256:4027705fb598ee07b016e17a06786e56c399f95308a54f7171fcc60871eb1738 AS dart_sdk

# Keep only the AOT analysis server's runtime inputs. In particular, do not
# carry dart, dartdev, pub, compiler snapshots, or repository configuration.
RUN set -eu; \
    test "$(cat /usr/lib/dart/version)" = "3.13.3"; \
    test -f /usr/lib/dart/bin/dartaotruntime; \
    test -f /usr/lib/dart/bin/snapshots/analysis_server_aot.dart.snapshot; \
    mkdir -p /staged/opt/graph-dart/bin/snapshots; \
    cp --dereference --preserve=mode /usr/lib/dart/bin/dartaotruntime /staged/opt/graph-dart/bin/dartaotruntime; \
    cp --dereference --preserve=mode /usr/lib/dart/bin/snapshots/analysis_server_aot.dart.snapshot /staged/opt/graph-dart/bin/snapshots/analysis_server_aot.dart.snapshot; \
    cp --dereference --preserve=mode /usr/lib/dart/version /staged/opt/graph-dart/version; \
    cp --recursive --dereference --preserve=mode,timestamps /usr/lib/dart/lib /staged/opt/graph-dart/lib; \
    find /staged/opt/graph-dart/lib -name '*.dill' -delete; \
    test -z "$(find /staged/opt/graph-dart -type l -print -quit)"; \
    test ! -e /staged/opt/graph-dart/bin/dart

# The pinned official Dart image stages its amd64 loader, glibc and related
# runtime shared libraries under /runtime. The COPY fails if that stage is
# absent. Scratch brings no shell, package manager, pub,
# Flutter wrapper, inherited environment, or host SDK into the analyzer.
FROM scratch
COPY --from=dart_sdk /runtime/ /
COPY --from=dart_sdk /staged/opt/graph-dart/ /opt/graph-dart/
LABEL org.graph-engineering.dart.source="dart@sha256:4027705fb598ee07b016e17a06786e56c399f95308a54f7171fcc60871eb1738" \
      org.graph-engineering.dart.sdk="3.13.3" \
      org.graph-engineering.dart.seccomp-sha256="acc39fa1d092743ddd053e8ab0557ea989c724ed5fb554665b40cd7132160e44"
USER 65534:65534
WORKDIR /work
ENTRYPOINT ["/opt/graph-dart/bin/dartaotruntime"]
