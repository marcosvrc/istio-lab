package main

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

func loadDocsFile(path string) ([]*yaml.Node, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return loadDocs(data)
}

func loadDocs(data []byte) ([]*yaml.Node, error) {
	dec := yaml.NewDecoder(bytes.NewReader(data))
	var docs []*yaml.Node
	for {
		n := &yaml.Node{}
		err := dec.Decode(n)
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, err
		}
		docs = append(docs, n)
	}
	return docs, nil
}

// lookup navega até o nó escalar em docs[doc] seguindo path ("spec.http.0.timeout").
func lookup(docs []*yaml.Node, doc int, path string) (*yaml.Node, error) {
	if doc < 0 || doc >= len(docs) {
		return nil, fmt.Errorf("documento %d não existe", doc)
	}
	n := docs[doc]
	if n.Kind == yaml.DocumentNode && len(n.Content) > 0 {
		n = n.Content[0]
	}
	for _, seg := range strings.Split(path, ".") {
		switch n.Kind {
		case yaml.MappingNode:
			var next *yaml.Node
			for i := 0; i+1 < len(n.Content); i += 2 {
				if n.Content[i].Value == seg {
					next = n.Content[i+1]
					break
				}
			}
			if next == nil {
				return nil, fmt.Errorf("chave %q não encontrada em %q", seg, path)
			}
			n = next
		case yaml.SequenceNode:
			idx, err := strconv.Atoi(seg)
			if err != nil || idx < 0 || idx >= len(n.Content) {
				return nil, fmt.Errorf("índice %q inválido em %q", seg, path)
			}
			n = n.Content[idx]
		default:
			return nil, fmt.Errorf("caminho %q passa por um valor escalar", path)
		}
	}
	if n.Kind != yaml.ScalarNode {
		return nil, fmt.Errorf("%q não é um valor escalar", path)
	}
	return n, nil
}

// renderManifest devolve o conteúdo do manifest com os parâmetros aplicados.
// Sem parâmetros alterados, devolve o arquivo original byte a byte.
func renderManifest(file string, params []*Param, values map[string]string) (string, error) {
	data, err := os.ReadFile(file)
	if err != nil {
		return "", err
	}
	changed := false
	for _, p := range params {
		if v, ok := values[p.Name]; ok && v != p.Default {
			changed = true
		}
	}
	if !changed {
		return string(data), nil
	}
	docs, err := loadDocs(data)
	if err != nil {
		return "", err
	}
	for _, p := range params {
		v, ok := values[p.Name]
		if !ok {
			continue
		}
		n, err := lookup(docs, p.Doc, p.Path)
		if err != nil {
			return "", err
		}
		switch p.Type {
		case "number":
			if _, err := strconv.ParseFloat(v, 64); err != nil {
				return "", fmt.Errorf("%s: %q não é um número", p.Label, v)
			}
			n.Tag = "!!int"
			if strings.Contains(v, ".") {
				n.Tag = "!!float"
			}
		default:
			if len(v) > 256 || strings.ContainsAny(v, "\n\r") {
				return "", fmt.Errorf("%s: valor inválido", p.Label)
			}
			n.Tag = "!!str"
		}
		n.Value = v
		n.Style = 0
	}
	var b bytes.Buffer
	enc := yaml.NewEncoder(&b)
	enc.SetIndent(2)
	for _, d := range docs {
		if err := enc.Encode(d); err != nil {
			return "", err
		}
	}
	if err := enc.Close(); err != nil {
		return "", err
	}
	return b.String(), nil
}

func countDocs(content string) int {
	docs, err := loadDocs([]byte(content))
	if err != nil {
		return 0
	}
	n := 0
	for _, d := range docs {
		if d.Kind == yaml.DocumentNode && len(d.Content) > 0 && d.Content[0].Kind == yaml.MappingNode {
			n++
		}
	}
	return n
}
