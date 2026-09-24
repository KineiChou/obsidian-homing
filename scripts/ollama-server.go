// Optional isolated acceptance launcher; build inside the pinned official Ollama source tree.
// It calls the unmodified server API without the CLI's user-home key initialization.
package main

import (
	"github.com/ollama/ollama/envconfig"
	"github.com/ollama/ollama/server"
	"log"
	"net"
)

func main() {
	listener, err := net.Listen("tcp", envconfig.Host().Host)
	if err != nil {
		log.Fatal(err)
	}
	if err := server.Serve(listener); err != nil {
		log.Fatal(err)
	}
}
