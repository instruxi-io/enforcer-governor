# GVNR MCP server over stdio. No dependencies, so nothing is installed beyond
# the base image.
#
#   docker build -t gvnr .
#   docker run -i --rm gvnr
#
# The tools talk to GVNR on localhost:GOVERNOR_PORT (default 4000), started
# with: npx enforcer-governor start. Inside a container that is the
# container itself, so run it with --network host (Linux) to reach a GVNR on
# the host. Without one the server still starts and lists its tools, and
# each call says GVNR is not running.
FROM node:22-alpine
WORKDIR /app
COPY package.json LICENSE ./
COPY src ./src
COPY public ./public
USER node
ENTRYPOINT ["node", "src/cli.mjs", "mcp"]
