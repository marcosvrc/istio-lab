package main

import (
	"context"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
)

type CaseResult struct {
	Label   string   `json:"label"`
	Where   string   `json:"where"`
	Script  string   `json:"script"`
	Counts  []Count  `json:"counts"`
	Total   int      `json:"total"`
	Expect  string   `json:"expect,omitempty"`
	Pass    *bool    `json:"pass,omitempty"`
	Error   string   `json:"error,omitempty"`
	Samples []string `json:"samples,omitempty"`
	Millis  int64    `json:"ms"`
}

type Count struct {
	Value string `json:"value"`
	N     int    `json:"n"`
}

// varCache guarda o valor das "vars" do módulo (ex.: tokens JWT baixados uma vez).
type varCache struct {
	mu   sync.Mutex
	vals map[string]map[string]string
}

func (a *App) moduleVars(ctx context.Context, m *Module) (map[string]string, error) {
	a.vars.mu.Lock()
	defer a.vars.mu.Unlock()
	if a.vars.vals == nil {
		a.vars.vals = map[string]map[string]string{}
	}
	if v, ok := a.vars.vals[m.ID]; ok {
		return v, nil
	}
	res := map[string]string{}
	names := make([]string, 0, len(m.Vars))
	for k := range m.Vars {
		names = append(names, k)
	}
	sort.Strings(names)
	for _, k := range names {
		out, err := a.exec.Shell(ctx, "script", "# variável "+k+"\n"+m.Vars[k], m.Dir, m.Vars[k])
		if err != nil {
			return nil, fmt.Errorf("variável %s: %v", k, err)
		}
		res[k] = strings.TrimSpace(out)
	}
	a.vars.vals[m.ID] = res
	return res, nil
}

// buildScript monta o loop que executa o caso N vezes, imprimindo uma linha
// por execução (a primeira linha da saída, mais o exit code se falhar).
func buildScript(c *Case, vars map[string]string) string {
	var b strings.Builder
	names := make([]string, 0, len(vars))
	for k := range vars {
		names = append(names, k)
	}
	sort.Strings(names)
	for _, k := range names {
		fmt.Fprintf(&b, "%s=%s\n", k, shQuote(vars[k]))
	}
	if c.Before != "" {
		b.WriteString(strings.TrimSpace(c.Before) + "\n")
	}
	if c.Tally != "" {
		b.WriteString(strings.TrimSpace(c.Run) + "\n")
		return b.String()
	}
	fmt.Fprintf(&b, `i=0
while [ "$i" -lt %d ]; do
  i=$((i+1))
  out=$( { %s
} 2>&1 ); rc=$?
  first=$(printf '%%s\n' "$out" | head -n1)
  [ -z "$first" ] && first="(vazio)"
  [ "$rc" -ne 0 ] && first="$first (exit $rc)"
  printf '%%s\n' "$first"
done
`, c.Repeat, strings.TrimSpace(c.Run))
	return b.String()
}

func (a *App) runCase(ctx context.Context, m *Module, c *Case) CaseResult {
	res := CaseResult{Label: c.Label, Expect: c.Expect, Counts: []Count{}}
	vars, err := a.moduleVars(ctx, m)
	if err != nil {
		res.Error = err.Error()
		return res
	}
	script := buildScript(c, vars)
	res.Script = script

	var out string
	if c.In == "" {
		res.Where = "local"
		out, err = a.exec.Shell(ctx, "test", "# "+c.Label+" (local)\n"+script, m.Dir, script)
	} else {
		res.Where = "pod curl em " + c.In
		out, err = a.exec.Run(ctx, ExecOpts{
			Kind:    "test",
			Display: fmt.Sprintf("# %s\nkubectl -n %s exec deploy/curl -c curl -- sh -c '...'\n%s", c.Label, c.In, script),
			Name:    "kubectl",
			Args:    []string{"--context", a.exec.Context, "-n", c.In, "exec", "deploy/curl", "-c", "curl", "--", "sh", "-c", script},
		})
	}
	if err != nil && c.Tally == "" {
		res.Error = strings.TrimSpace(firstLine(out) + " " + err.Error())
		return res
	}

	counts := map[string]int{}
	order := []string{}
	add := func(v string, n int) {
		if _, ok := counts[v]; !ok {
			order = append(order, v)
		}
		counts[v] += n
		res.Total += n
	}
	lines := strings.Split(strings.TrimRight(out, "\n"), "\n")
	if c.Tally != "" {
		re, rerr := regexp.Compile(c.Tally)
		if rerr != nil {
			res.Error = "tally inválido: " + rerr.Error()
			return res
		}
		for _, l := range lines {
			if mm := re.FindStringSubmatch(l); len(mm) == 3 {
				n, _ := strconv.Atoi(mm[2])
				add(mm[1], n)
			}
		}
		if res.Total == 0 {
			res.Error = "nenhuma linha reconhecida na saída: " + firstLine(out)
			return res
		}
	} else {
		for _, l := range lines {
			add(l, 1)
		}
	}
	sort.SliceStable(order, func(i, j int) bool { return counts[order[i]] > counts[order[j]] })
	for _, v := range order {
		res.Counts = append(res.Counts, Count{Value: v, N: counts[v]})
	}
	if c.Expect != "" {
		re, rerr := regexp.Compile("^(?:" + c.Expect + ")$")
		pass := rerr == nil
		if pass {
			for _, v := range order {
				if !re.MatchString(v) {
					pass = false
					break
				}
			}
		}
		res.Pass = &pass
	}
	return res
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i]
	}
	return s
}
