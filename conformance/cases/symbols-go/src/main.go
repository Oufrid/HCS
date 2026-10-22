package main

type Server struct {
	Port int
}

func (s *Server) Start() error {
	return nil
}

func main() {
	s := Server{Port: 8080}
	s.Start()
}
