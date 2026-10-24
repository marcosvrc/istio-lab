package main

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// Executor roda comandos externos e mantém um log dos comandos executados,
// exibido na tela para que o aluno veja exatamente o que foi feito.
type Executor struct {
	Context string // contexto do kubeconfig

	mu   sync.Mutex
	log  []LogEntry
	next int
}

type LogEntry struct {
	ID      int       `json:"id"`
	Time    time.Time `json:"time"`
	Kind    string    `json:"kind"` // kubectl | action | test | script
	Command string    `json:"command"`
	Output  string    `json:"output"`
	OK      bool      `json:"ok"`
	Millis  int64     `json:"ms"`
}

type ExecOpts struct {
	Kind    string
	Display string // comando como aparece no log
	Name    string
	Args    []string
	Stdin   string
	Dir     string
	Quiet   bool // não registra no log (consultas de status)
}

const maxLogEntries = 300
const maxLogOutput = 16 * 1024

// shellPrelude faz kubectl/istioctl usarem o contexto do console dentro dos
// scripts de ações e testes, sem precisar escrever --context em cada comando.
func (e *Executor) shellPrelude() string {
	return "kubectl() { command kubectl --context " + shQuote(e.Context) + ` "$@"; }
istioctl() { command istioctl --context ` + shQuote(e.Context) + ` "$@"; }
`
}

func (e *Executor) Run(ctx context.Context, o ExecOpts) (string, error) {
	start := time.Now()
	cmd := exec.CommandContext(ctx, o.Name, o.Args...)
	cmd.Dir = o.Dir
	cmd.Env = append(os.Environ(), "KUBE_CONTEXT="+e.Context)
	if o.Stdin != "" {
		cmd.Stdin = strings.NewReader(o.Stdin)
	}
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	err := cmd.Run()
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		err = errors.New("tempo esgotado")
	}
	output := out.String()
	if !o.Quiet {
		e.record(LogEntry{
			Time:    start,
			Kind:    o.Kind,
			Command: o.Display,
			Output:  truncate(output, maxLogOutput),
			OK:      err == nil,
			Millis:  time.Since(start).Milliseconds(),
		})
	}
	return output, err
}

func (e *Executor) Kubectl(ctx context.Context, display, stdin string, quiet bool, args ...string) (string, error) {
	return e.Run(ctx, ExecOpts{
		Kind:    "kubectl",
		Display: "kubectl " + display,
		Name:    "kubectl",
		Args:    append([]string{"--context", e.Context}, args...),
		Stdin:   stdin,
		Quiet:   quiet,
	})
}

// Shell roda um script sh localmente (com kubectl/istioctl já no contexto certo).
func (e *Executor) Shell(ctx context.Context, kind, display, dir, script string) (string, error) {
	return e.Run(ctx, ExecOpts{
		Kind:    kind,
		Display: display,
		Name:    "sh",
		Args:    []string{"-c", e.shellPrelude() + script},
		Dir:     dir,
	})
}

func (e *Executor) record(le LogEntry) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.next++
	le.ID = e.next
	e.log = append(e.log, le)
	if len(e.log) > maxLogEntries {
		e.log = e.log[len(e.log)-maxLogEntries:]
	}
}

func (e *Executor) Since(id int) []LogEntry {
	e.mu.Lock()
	defer e.mu.Unlock()
	res := []LogEntry{}
	for _, le := range e.log {
		if le.ID > id {
			res = append(res, le)
		}
	}
	return res
}

func shQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "\n… (saída truncada)"
}
