If you already know about the project run the code below to run it

```bash
systemfd --no-pid -s http::8080 -- cargo watch -x run
```

OR

```bash
systemfd --no-pid -s http::8080 -- \
  cargo watch -i ".cargo/*" -i "target/*" -i ".git/*" -i "static/*" -i "logs/*" -x run
```

If you don't know about the project run the code below to read the full documentation

```bash
mkdocs serve
```
