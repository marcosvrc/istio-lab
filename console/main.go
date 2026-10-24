// istio-lab console: interface web local para aplicar os manifests dos
// exercícios, ajustar parâmetros, rodar testes e ver os comandos executados.
package main

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

//go:embed web
var webFS embed.FS

type App struct {
	root    string
	exec    *Executor
	dash    *Dashboards
	vars    varCache
	catMu   sync.RWMutex
	catalog *Catalog
	// últimos parâmetros aplicados por manifest ("módulo/exercício/manifest"),
	// usados para comparar o estado do cluster com o que foi aplicado
	paramsMu sync.Mutex
	params   map[string]map[string]string
}

func main() {
	addr := flag.String("addr", "127.0.0.1:7070", "endereço HTTP (mantenha em 127.0.0.1)")
	kctx := flag.String("context", envOr("KUBE_CONTEXT", "rancher-desktop"), "contexto do kubeconfig")
	repo := flag.String("repo", "..", "raiz do repositório istio-lab")
	flag.Parse()

	root, err := filepath.Abs(*repo)
	if err != nil {
		log.Fatal(err)
	}
	cat, err := LoadCatalog(root)
	if err != nil {
		log.Fatal(err)
	}
	ex := &Executor{Context: *kctx}
	app := &App{root: root, exec: ex, dash: NewDashboards(ex), catalog: cat, params: map[string]map[string]string{}}

	mux := http.NewServeMux()
	app.routes(mux)
	web, _ := fs.Sub(webFS, "web")
	mux.Handle("/", http.FileServer(http.FS(web)))

	srv := &http.Server{Addr: *addr, Handler: mux}
	go func() {
		sig := make(chan os.Signal, 1)
		signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
		<-sig
		app.dash.StopAll()
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)
	}()
	log.Printf("istio-lab console em http://%s  (contexto %q, %d módulos)", *addr, *kctx, len(cat.Modules))
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

func (a *App) routes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/catalog", a.handleCatalog)
	mux.HandleFunc("POST /api/catalog/reload", a.handleReload)
	mux.HandleFunc("GET /api/cluster", a.handleCluster)
	mux.HandleFunc("GET /api/status", a.handleStatus)
	mux.HandleFunc("POST /api/manifest/render", a.handleManifest("render"))
	mux.HandleFunc("POST /api/manifest/apply", a.handleManifest("apply"))
	mux.HandleFunc("POST /api/manifest/delete", a.handleManifest("delete"))
	mux.HandleFunc("POST /api/action", a.handleAction)
	mux.HandleFunc("POST /api/test", a.handleTest)
	mux.HandleFunc("POST /api/script", a.handleScript)
	mux.HandleFunc("GET /api/log", a.handleLog)
	mux.HandleFunc("GET /api/dashboards", a.handleDashboards)
	mux.HandleFunc("POST /api/dashboards/{name}", a.handleDashboardOpen)
}

// ---- catálogo ----

func (a *App) cat() *Catalog {
	a.catMu.RLock()
	defer a.catMu.RUnlock()
	return a.catalog
}

func (a *App) handleCatalog(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"context": a.exec.Context, "modules": a.cat().Modules})
}

func (a *App) handleReload(w http.ResponseWriter, r *http.Request) {
	cat, err := LoadCatalog(a.root)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	a.catMu.Lock()
	a.catalog = cat
	a.catMu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{"modules": len(cat.Modules)})
}

// ---- cluster ----

type component struct {
	Name    string `json:"name"`
	Kind    string `json:"kind"`
	Ready   int    `json:"ready"`
	Desired int    `json:"desired"`
}

func (a *App) handleCluster(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	res := map[string]any{"context": a.exec.Context, "reachable": false}
	out, err := a.exec.Kubectl(ctx, "", "", true, "-n", "istio-system", "get", "deploy,ds", "-o", "json")
	if err != nil {
		res["error"] = firstLine(out)
		writeJSON(w, http.StatusOK, res)
		return
	}
	var list struct {
		Items []struct {
			Kind     string `json:"kind"`
			Metadata struct {
				Name string `json:"name"`
			} `json:"metadata"`
			Spec struct {
				Replicas *int `json:"replicas"`
				Template struct {
					Spec struct {
						Containers []struct {
							Image string `json:"image"`
						} `json:"containers"`
					} `json:"spec"`
				} `json:"template"`
			} `json:"spec"`
			Status struct {
				ReadyReplicas          int `json:"readyReplicas"`
				NumberReady            int `json:"numberReady"`
				DesiredNumberScheduled int `json:"desiredNumberScheduled"`
			} `json:"status"`
		} `json:"items"`
	}
	if err := json.Unmarshal([]byte(out), &list); err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	comps := []component{}
	for _, it := range list.Items {
		c := component{Name: it.Metadata.Name, Kind: it.Kind}
		if it.Kind == "DaemonSet" {
			c.Ready, c.Desired = it.Status.NumberReady, it.Status.DesiredNumberScheduled
			if it.Metadata.Name == "ztunnel" {
				res["ambient"] = true
			}
		} else {
			c.Ready, c.Desired = it.Status.ReadyReplicas, 1
			if it.Spec.Replicas != nil {
				c.Desired = *it.Spec.Replicas
			}
		}
		if it.Metadata.Name == "istiod" && len(it.Spec.Template.Spec.Containers) > 0 {
			img := it.Spec.Template.Spec.Containers[0].Image
			if i := strings.LastIndex(img, ":"); i >= 0 {
				res["istio"] = img[i+1:]
			}
		}
		comps = append(comps, c)
	}
	res["reachable"] = true
	res["components"] = comps
	writeJSON(w, http.StatusOK, res)
}

// ---- manifests ----

type manifestReq struct {
	Module   string            `json:"module"`
	Exercise int               `json:"exercise"`
	Manifest int               `json:"manifest"`
	Params   map[string]string `json:"params"`
}

func (a *App) resolveManifest(req manifestReq) (*Module, *Manifest, error) {
	m, err := a.cat().Module(req.Module)
	if err != nil {
		return nil, nil, err
	}
	ex, err := m.Exercise(req.Exercise)
	if err != nil {
		return nil, nil, err
	}
	if req.Manifest < 0 || req.Manifest >= len(ex.Manifests) {
		return nil, nil, fmt.Errorf("manifest %d não existe", req.Manifest)
	}
	return m, ex.Manifests[req.Manifest], nil
}

func paramsKey(module string, ex, mf int) string { return fmt.Sprintf("%s/%d/%d", module, ex, mf) }

func describeParams(values map[string]string, params []*Param) string {
	var parts []string
	for _, p := range params {
		if v, ok := values[p.Name]; ok && v != p.Default {
			parts = append(parts, p.Name+"="+v)
		}
	}
	if len(parts) == 0 {
		return ""
	}
	return "   # parâmetros: " + strings.Join(parts, ", ")
}

func (a *App) handleManifest(op string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req manifestReq
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeErr(w, http.StatusBadRequest, err)
			return
		}
		m, mf, err := a.resolveManifest(req)
		if err != nil {
			writeErr(w, http.StatusBadRequest, err)
			return
		}
		file := filepath.Join(m.Dir, mf.Path)
		content, err := renderManifest(file, mf.Params, req.Params)
		if err != nil {
			writeErr(w, http.StatusBadRequest, err)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
		defer cancel()
		rel := filepath.Join(m.ID, mf.Path)
		switch op {
		case "render":
			writeJSON(w, http.StatusOK, map[string]any{"yaml": content})
		case "apply":
			out, err := a.exec.Kubectl(ctx, "apply -f "+rel+describeParams(req.Params, mf.Params), content, false, "apply", "-f", "-")
			if err == nil {
				a.paramsMu.Lock()
				a.params[paramsKey(m.ID, req.Exercise, req.Manifest)] = req.Params
				a.paramsMu.Unlock()
			}
			writeJSON(w, http.StatusOK, map[string]any{"ok": err == nil, "output": out})
		case "delete":
			out, err := a.exec.Kubectl(ctx, "delete --ignore-not-found -f "+rel, "", false, "delete", "--ignore-not-found", "-f", file)
			writeJSON(w, http.StatusOK, map[string]any{"ok": err == nil, "output": out})
		}
	}
}

// ---- status dos manifests de um módulo ----

func (a *App) handleStatus(w http.ResponseWriter, r *http.Request) {
	m, err := a.cat().Module(r.URL.Query().Get("module"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()

	res := make([][]string, len(m.Exercises))
	var wg sync.WaitGroup
	sem := make(chan struct{}, 6)
	for ei, ex := range m.Exercises {
		res[ei] = make([]string, len(ex.Manifests))
		for mi, mf := range ex.Manifests {
			wg.Add(1)
			go func(ei, mi int, mf *Manifest) {
				defer wg.Done()
				sem <- struct{}{}
				defer func() { <-sem }()
				a.paramsMu.Lock()
				values := a.params[paramsKey(m.ID, ei, mi)]
				a.paramsMu.Unlock()
				res[ei][mi] = a.manifestState(ctx, filepath.Join(m.Dir, mf.Path), mf.Params, values)
			}(ei, mi, mf)
		}
	}
	wg.Wait()
	writeJSON(w, http.StatusOK, map[string]any{"exercises": res})
}

// manifestState: applied (existe e igual), modified (existe e diferente),
// partial (só parte dos recursos existe), absent, error.
func (a *App) manifestState(ctx context.Context, file string, params []*Param, values map[string]string) string {
	content, err := renderManifest(file, params, values)
	if err != nil {
		return "error"
	}
	total := countDocs(content)
	out, err := a.exec.Kubectl(ctx, "", content, true, "get", "-f", "-", "-o", "name", "--ignore-not-found")
	if err != nil {
		return "error"
	}
	existing := 0
	for _, l := range strings.Split(strings.TrimSpace(out), "\n") {
		if strings.TrimSpace(l) != "" {
			existing++
		}
	}
	switch {
	case existing == 0:
		return "absent"
	case existing < total:
		return "partial"
	}
	_, err = a.exec.Kubectl(ctx, "", content, true, "diff", "-f", "-")
	if err == nil {
		return "applied"
	}
	var ee *exec.ExitError
	if errors.As(err, &ee) && ee.ExitCode() == 1 {
		return "modified"
	}
	return "error"
}

// ---- ações, testes e scripts ----

type itemReq struct {
	Module   string `json:"module"`
	Exercise int    `json:"exercise"`
	Index    int    `json:"index"`
}

func (a *App) resolveExercise(req itemReq) (*Module, *Exercise, error) {
	m, err := a.cat().Module(req.Module)
	if err != nil {
		return nil, nil, err
	}
	ex, err := m.Exercise(req.Exercise)
	return m, ex, err
}

func (a *App) handleAction(w http.ResponseWriter, r *http.Request) {
	var req itemReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	m, ex, err := a.resolveExercise(req)
	if err != nil || req.Index < 0 || req.Index >= len(ex.Actions) {
		writeErr(w, http.StatusBadRequest, errors.Join(err, errors.New("ação inválida")))
		return
	}
	act := ex.Actions[req.Index]
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Minute)
	defer cancel()
	out, err := a.exec.Shell(ctx, "action", "# "+act.Label+"\n"+strings.TrimSpace(act.Run), m.Dir, act.Run)
	writeJSON(w, http.StatusOK, map[string]any{"ok": err == nil, "output": out})
}

func (a *App) handleTest(w http.ResponseWriter, r *http.Request) {
	var req itemReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	m, ex, err := a.resolveExercise(req)
	if err != nil || req.Index < 0 || req.Index >= len(ex.Tests) {
		writeErr(w, http.StatusBadRequest, errors.Join(err, errors.New("teste inválido")))
		return
	}
	t := ex.Tests[req.Index]
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Minute)
	defer cancel()
	results := make([]CaseResult, 0, len(t.Cases))
	for _, c := range t.Cases {
		start := time.Now()
		cr := a.runCase(ctx, m, c)
		cr.Millis = time.Since(start).Milliseconds()
		results = append(results, cr)
	}
	writeJSON(w, http.StatusOK, map[string]any{"cases": results})
}

func (a *App) handleScript(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Module string `json:"module"`
		Script string `json:"script"` // setup | reset
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	m, err := a.cat().Module(req.Module)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	script := map[string]string{"setup": m.Setup, "reset": m.Reset}[req.Script]
	if script == "" {
		writeErr(w, http.StatusBadRequest, fmt.Errorf("módulo %s não tem script %q", m.ID, req.Script))
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Minute)
	defer cancel()
	out, err := a.exec.Run(ctx, ExecOpts{
		Kind: "script", Display: "cd " + m.ID + " && ./" + script,
		Name: "./" + script, Dir: m.Dir,
	})
	a.paramsMu.Lock()
	for k := range a.params {
		if strings.HasPrefix(k, m.ID+"/") {
			delete(a.params, k)
		}
	}
	a.paramsMu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{"ok": err == nil, "output": out})
}

// ---- log e dashboards ----

func (a *App) handleLog(w http.ResponseWriter, r *http.Request) {
	after, _ := strconv.Atoi(r.URL.Query().Get("after"))
	writeJSON(w, http.StatusOK, map[string]any{"entries": a.exec.Since(after)})
}

func (a *App) handleDashboards(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"dashboards": a.dash.List()})
}

func (a *App) handleDashboardOpen(w http.ResponseWriter, r *http.Request) {
	url, err := a.dash.Open(r.PathValue("name"))
	if err != nil {
		writeErr(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"url": url})
}

// ---- utilitários ----

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, err error) {
	writeJSON(w, code, map[string]any{"error": err.Error()})
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
