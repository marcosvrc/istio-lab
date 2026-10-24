package main

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"

	"gopkg.in/yaml.v3"
)

// Catalog é o conjunto de módulos descritos pelos arquivos <módulo>/console.yaml.
type Catalog struct {
	Modules []*Module `json:"modules"`
}

type Module struct {
	ID        string            `yaml:"-" json:"id"` // nome do diretório, ex.: 01-traffic-management
	Dir       string            `yaml:"-" json:"-"`
	Title     string            `yaml:"title" json:"title"`
	Summary   string            `yaml:"summary" json:"summary"`
	Setup     string            `yaml:"setup" json:"setup,omitempty"`
	Reset     string            `yaml:"reset" json:"reset,omitempty"`
	Vars      map[string]string `yaml:"vars" json:"-"`
	Exercises []*Exercise       `yaml:"exercises" json:"exercises"`
}

type Exercise struct {
	Title     string      `yaml:"title" json:"title"`
	Summary   string      `yaml:"summary" json:"summary"`
	Manifests []*Manifest `yaml:"manifests" json:"manifests"`
	Actions   []*Action   `yaml:"actions" json:"actions"`
	Tests     []*Test     `yaml:"tests" json:"tests"`
}

// Manifest é um arquivo YAML do módulo, opcionalmente com parâmetros editáveis.
type Manifest struct {
	Path   string   `yaml:"path" json:"path"`
	Note   string   `yaml:"note" json:"note,omitempty"`
	Params []*Param `yaml:"params" json:"params"`
	// Resources: recursos declarados no arquivo, para a interface mostrar
	// (kind/nome/namespace). Calculado ao carregar o catálogo.
	Resources []Resource `yaml:"-" json:"resources"`
}

type Resource struct {
	APIVersion string `json:"apiVersion"`
	Kind       string `json:"kind"`
	Name       string `json:"name"`
	Namespace  string `json:"namespace,omitempty"`
}

// Param aponta para um valor escalar dentro do manifest (doc = índice do
// documento no arquivo multi-doc; path = chaves/índices separados por ponto).
type Param struct {
	Name    string `yaml:"name" json:"name"`
	Label   string `yaml:"label" json:"label"`
	Type    string `yaml:"type" json:"type"` // number | text
	Doc     int    `yaml:"doc" json:"-"`
	Path    string `yaml:"path" json:"-"`
	Hint    string `yaml:"hint" json:"hint,omitempty"`
	Default string `yaml:"-" json:"default"`
}

// Action é um comando de shell executado localmente, no diretório do módulo.
type Action struct {
	Label string `yaml:"label" json:"label"`
	Run   string `yaml:"run" json:"run"`
}

type Test struct {
	Title   string  `yaml:"title" json:"title"`
	Summary string  `yaml:"summary" json:"summary,omitempty"`
	Chart   bool    `yaml:"chart" json:"chart"`
	Cases   []*Case `yaml:"cases" json:"cases"`
}

// Case é executado Repeat vezes; cada execução produz uma linha (amostra).
// In = namespace com deploy/curl para rodar de dentro da mesh; vazio = local.
// Tally = regex com 2 grupos (rótulo, quantidade) aplicada a cada linha de uma
// única execução, para saídas que já vêm agregadas (ex.: fortio).
type Case struct {
	Label  string `yaml:"label" json:"label"`
	In     string `yaml:"in" json:"in,omitempty"`
	Before string `yaml:"before" json:"before,omitempty"`
	Run    string `yaml:"run" json:"run"`
	Repeat int    `yaml:"repeat" json:"repeat"`
	Expect string `yaml:"expect" json:"expect,omitempty"`
	Tally  string `yaml:"tally" json:"tally,omitempty"`
}

func LoadCatalog(root string) (*Catalog, error) {
	files, err := filepath.Glob(filepath.Join(root, "*", "console.yaml"))
	if err != nil {
		return nil, err
	}
	sort.Strings(files)
	cat := &Catalog{}
	for _, f := range files {
		m, err := loadModule(f)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", f, err)
		}
		cat.Modules = append(cat.Modules, m)
	}
	if len(cat.Modules) == 0 {
		return nil, fmt.Errorf("nenhum console.yaml encontrado em %s/*/", root)
	}
	return cat, nil
}

func loadModule(file string) (*Module, error) {
	data, err := os.ReadFile(file)
	if err != nil {
		return nil, err
	}
	m := &Module{}
	if err := yaml.Unmarshal(data, m); err != nil {
		return nil, err
	}
	m.Dir = filepath.Dir(file)
	m.ID = filepath.Base(m.Dir)

	for ei, ex := range m.Exercises {
		for _, mf := range ex.Manifests {
			if mf.Params == nil {
				mf.Params = []*Param{}
			}
			docs, err := loadDocsFile(filepath.Join(m.Dir, mf.Path))
			if err != nil {
				return nil, fmt.Errorf("exercício %d: %w", ei+1, err)
			}
			mf.Resources = resources(docs)
			for _, p := range mf.Params {
				if p.Type == "" {
					p.Type = "text"
				}
				n, err := lookup(docs, p.Doc, p.Path)
				if err != nil {
					return nil, fmt.Errorf("exercício %d, %s, parâmetro %s: %w", ei+1, mf.Path, p.Name, err)
				}
				p.Default = n.Value
			}
		}
		for _, t := range ex.Tests {
			for _, c := range t.Cases {
				if c.Repeat < 1 {
					c.Repeat = 1
				}
			}
		}
		if ex.Manifests == nil {
			ex.Manifests = []*Manifest{}
		}
		if ex.Actions == nil {
			ex.Actions = []*Action{}
		}
		if ex.Tests == nil {
			ex.Tests = []*Test{}
		}
	}
	return m, nil
}

func (c *Catalog) Module(id string) (*Module, error) {
	for _, m := range c.Modules {
		if m.ID == id {
			return m, nil
		}
	}
	return nil, fmt.Errorf("módulo %q não encontrado", id)
}

func (m *Module) Exercise(i int) (*Exercise, error) {
	if i < 0 || i >= len(m.Exercises) {
		return nil, fmt.Errorf("exercício %d não existe em %s", i, m.ID)
	}
	return m.Exercises[i], nil
}
