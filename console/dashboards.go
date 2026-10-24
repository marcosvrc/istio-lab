package main

import (
	"context"
	"fmt"
	"net"
	"os/exec"
	"sync"
	"time"
)

// Dashboards mantém port-forwards para as UIs da mesh enquanto o console roda.
type Dashboard struct {
	Name       string `json:"name"`
	Label      string `json:"label"`
	Namespace  string `json:"-"`
	Target     string `json:"-"`
	LocalPort  int    `json:"port"`
	RemotePort int    `json:"-"`
	Path       string `json:"-"`
	Running    bool   `json:"running"`
}

var dashboardDefs = []Dashboard{
	{Name: "kiali", Label: "Kiali", Namespace: "istio-system", Target: "svc/kiali", LocalPort: 20001, RemotePort: 20001, Path: "/kiali"},
	{Name: "grafana", Label: "Grafana", Namespace: "istio-system", Target: "svc/grafana", LocalPort: 3000, RemotePort: 3000, Path: "/dashboards"},
	{Name: "jaeger", Label: "Jaeger", Namespace: "istio-system", Target: "svc/tracing", LocalPort: 16686, RemotePort: 80, Path: "/jaeger"},
	{Name: "prometheus", Label: "Prometheus", Namespace: "istio-system", Target: "svc/prometheus", LocalPort: 9090, RemotePort: 9090, Path: "/"},
	{Name: "fortio", Label: "fortio", Namespace: "sandbox", Target: "svc/fortio", LocalPort: 8088, RemotePort: 8080, Path: "/fortio/"},
}

type Dashboards struct {
	exec *Executor
	mu   sync.Mutex
	proc map[string]*exec.Cmd
}

func NewDashboards(e *Executor) *Dashboards {
	return &Dashboards{exec: e, proc: map[string]*exec.Cmd{}}
}

func (d *Dashboards) List() []Dashboard {
	d.mu.Lock()
	defer d.mu.Unlock()
	res := make([]Dashboard, len(dashboardDefs))
	copy(res, dashboardDefs)
	for i := range res {
		_, res[i].Running = d.proc[res[i].Name]
	}
	return res
}

func (d *Dashboards) Open(name string) (string, error) {
	var def *Dashboard
	for i := range dashboardDefs {
		if dashboardDefs[i].Name == name {
			def = &dashboardDefs[i]
		}
	}
	if def == nil {
		return "", fmt.Errorf("dashboard %q desconhecido", name)
	}
	url := fmt.Sprintf("http://localhost:%d%s", def.LocalPort, def.Path)

	d.mu.Lock()
	defer d.mu.Unlock()
	if _, ok := d.proc[name]; ok && portOpen(def.LocalPort) {
		return url, nil
	}
	if portOpen(def.LocalPort) {
		return "", fmt.Errorf("a porta %d já está em uso por outro processo", def.LocalPort)
	}
	args := []string{"--context", d.exec.Context, "-n", def.Namespace, "port-forward", def.Target,
		fmt.Sprintf("%d:%d", def.LocalPort, def.RemotePort)}
	cmd := exec.Command("kubectl", args...)
	if err := cmd.Start(); err != nil {
		return "", err
	}
	d.exec.record(LogEntry{Time: time.Now(), Kind: "kubectl", OK: true,
		Command: fmt.Sprintf("kubectl -n %s port-forward %s %d:%d   # %s", def.Namespace, def.Target, def.LocalPort, def.RemotePort, def.Label)})
	d.proc[name] = cmd
	go func() {
		_ = cmd.Wait()
		d.mu.Lock()
		if d.proc[name] == cmd {
			delete(d.proc, name)
		}
		d.mu.Unlock()
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for ctx.Err() == nil {
		if portOpen(def.LocalPort) {
			return url, nil
		}
		time.Sleep(200 * time.Millisecond)
	}
	return "", fmt.Errorf("port-forward para %s não respondeu em 10s", def.Label)
}

func (d *Dashboards) StopAll() {
	d.mu.Lock()
	defer d.mu.Unlock()
	for _, c := range d.proc {
		if c.Process != nil {
			_ = c.Process.Kill()
		}
	}
}

func portOpen(port int) bool {
	c, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 200*time.Millisecond)
	if err != nil {
		return false
	}
	c.Close()
	return true
}
