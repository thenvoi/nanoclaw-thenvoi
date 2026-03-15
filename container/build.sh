#!/bin/bash
# Build the NanoClaw agent container image

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$SCRIPT_DIR"

IMAGE_NAME="nanoclaw-agent"
TAG="${1:-latest}"
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-docker}"

echo "Building NanoClaw agent container image..."
echo "Image: ${IMAGE_NAME}:${TAG}"

# Pack Thenvoi SDKs into tarballs for container install.
# The container can't use file: references to host paths, so we pack them
# into the build context and install from tarballs.
VENDOR_DIR="$SCRIPT_DIR/agent-runner/vendor"
mkdir -p "$VENDOR_DIR"

SDK_DIR="${THENVOI_SDK_DIR:-$PROJECT_ROOT/../thenvoi-sdk-typescript}"
FERN_DIR="${THENVOI_FERN_DIR:-$PROJECT_ROOT/../fern-javascript-sdk}"

if [ -d "$SDK_DIR" ] && [ -f "$SDK_DIR/package.json" ]; then
  echo "Packing @thenvoi/sdk from $SDK_DIR"
  (cd "$SDK_DIR" && npm pack --pack-destination "$VENDOR_DIR" 2>/dev/null)
  # npm pack creates thenvoi-sdk-*.tgz — rename to stable name
  mv "$VENDOR_DIR"/thenvoi-sdk-*.tgz "$VENDOR_DIR/thenvoi-sdk.tgz" 2>/dev/null || true
else
  echo "Warning: @thenvoi/sdk not found at $SDK_DIR — skipping"
fi

if [ -d "$FERN_DIR" ] && [ -f "$FERN_DIR/package.json" ]; then
  echo "Packing @thenvoi/rest-client from $FERN_DIR"
  (cd "$FERN_DIR" && npm pack --pack-destination "$VENDOR_DIR" 2>/dev/null)
  mv "$VENDOR_DIR"/thenvoi-rest-client-*.tgz "$VENDOR_DIR/thenvoi-rest-client.tgz" 2>/dev/null || true
else
  echo "Warning: @thenvoi/rest-client not found at $FERN_DIR — skipping"
fi

# Pass --no-cache if NO_CACHE is set or if vendor tarballs are newer than the image
BUILD_ARGS=""
if [ "${NO_CACHE:-}" = "1" ]; then
  BUILD_ARGS="--no-cache"
fi

${CONTAINER_RUNTIME} build ${BUILD_ARGS} -t "${IMAGE_NAME}:${TAG}" .

# Clean up vendored tarballs
rm -rf "$VENDOR_DIR"

echo ""
echo "Build complete!"
echo "Image: ${IMAGE_NAME}:${TAG}"
echo ""
echo "Test with:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | ${CONTAINER_RUNTIME} run -i ${IMAGE_NAME}:${TAG}"
