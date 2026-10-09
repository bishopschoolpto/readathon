// Open Library title search suggestions. Picking a suggestion fills title + author
// and remembers the cover id / ISBN so covers don't need a lookup later.
(function () {
  function attach(titleInput, authorInput, list) {
    var timer = null;
    var seq = 0;
    var selected = null;

    function hide() { list.hidden = true; list.innerHTML = ''; }

    titleInput.addEventListener('input', function () {
      selected = null;
      clearTimeout(timer);
      var q = titleInput.value.trim();
      if (q.length < 3) return hide();
      timer = setTimeout(function () { search(q); }, 350);
    });
    titleInput.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') hide();
      if (e.key === 'ArrowDown' && !list.hidden) {
        e.preventDefault();
        var first = list.querySelector('button');
        if (first) first.focus();
      }
    });
    document.addEventListener('click', function (e) {
      if (!list.contains(e.target) && e.target !== titleInput) hide();
    });

    async function search(q) {
      var mine = ++seq;
      try {
        var params = new URLSearchParams({ q: q, limit: '6', fields: 'title,author_name,cover_i,isbn' });
        var res = await fetch('https://openlibrary.org/search.json?' + params);
        var json = await res.json();
        if (mine !== seq) return;
        render(json.docs || []);
      } catch (e) {
        hide(); // Suggestions are a nicety; typing the title still works.
      }
    }

    function render(docs) {
      list.innerHTML = '';
      if (!docs.length) return hide();
      docs.forEach(function (d) {
        var li = document.createElement('li');
        var b = document.createElement('button');
        b.type = 'button';
        var author = (d.author_name || [])[0] || '';
        b.innerHTML = (d.cover_i
          ? '<img alt="" referrerpolicy="no-referrer" src="https://covers.openlibrary.org/b/id/' + d.cover_i + '-S.jpg">'
          : '<span class="ph"></span>') +
          '<span><strong>' + RA.esc(d.title) + '</strong><br><span class="muted small">' + RA.esc(author) + '</span></span>';
        b.addEventListener('click', function () {
          titleInput.value = d.title;
          authorInput.value = author;
          selected = { coverId: d.cover_i ? String(d.cover_i) : '', isbn: (d.isbn || [])[0] || '' };
          hide();
          authorInput.focus();
        });
        b.addEventListener('keydown', function (e) {
          if (e.key === 'ArrowDown' && li.nextSibling) { e.preventDefault(); li.nextSibling.querySelector('button').focus(); }
          if (e.key === 'ArrowUp') { e.preventDefault(); (li.previousSibling ? li.previousSibling.querySelector('button') : titleInput).focus(); }
          if (e.key === 'Escape') { hide(); titleInput.focus(); }
        });
        li.appendChild(b);
        list.appendChild(li);
      });
      list.hidden = false;
    }

    return {
      /** Title, author and (if a suggestion was picked) cover id + ISBN. */
      value: function () {
        return {
          title: titleInput.value.trim(),
          author: authorInput.value.trim(),
          coverId: selected ? selected.coverId : '',
          isbn: selected ? selected.isbn : '',
        };
      },
      reset: function () { titleInput.value = ''; authorInput.value = ''; selected = null; hide(); },
    };
  }

  window.BookSearch = { attach: attach };
})();
