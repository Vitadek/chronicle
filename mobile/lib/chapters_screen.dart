import 'package:flutter/material.dart';

import 'api.dart';
import 'editor_screen.dart';
import 'models.dart';

/// Chapter list for one manuscript — GET /api/manuscripts/:id. The loaded
/// Manuscript is held here and handed to the editor by reference, so an edit +
/// save (PUT) round-trips the whole document.
class ChaptersScreen extends StatefulWidget {
  final ChronicleApi api;
  final ManuscriptMeta meta;
  const ChaptersScreen({super.key, required this.api, required this.meta});

  @override
  State<ChaptersScreen> createState() => _ChaptersScreenState();
}

class _ChaptersScreenState extends State<ChaptersScreen> {
  late Future<Manuscript> _future;

  @override
  void initState() {
    super.initState();
    _future = widget.api.get(widget.meta.id);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(widget.meta.title, maxLines: 1, overflow: TextOverflow.ellipsis),
      ),
      body: FutureBuilder<Manuscript>(
        future: _future,
        builder: (context, snap) {
          if (snap.connectionState != ConnectionState.done) {
            return const Center(child: CircularProgressIndicator());
          }
          if (snap.hasError) {
            return Center(child: Text('${snap.error}'));
          }
          final m = snap.data!;
          if (m.chapters.isEmpty) {
            return const Center(child: Text('This manuscript has no chapters.'));
          }
          return ListView.separated(
            itemCount: m.chapters.length,
            separatorBuilder: (_, __) => const Divider(height: 1),
            itemBuilder: (context, i) {
              final c = m.chapters[i];
              return ListTile(
                leading: CircleAvatar(child: Text('${i + 1}')),
                title: Text(
                  c.title.isEmpty ? 'Untitled Chapter' : c.title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
                trailing: const Icon(Icons.edit_outlined),
                onTap: () => Navigator.push(
                  context,
                  MaterialPageRoute(
                    builder: (_) =>
                        EditorScreen(api: widget.api, manuscript: m, chapterIndex: i),
                  ),
                ),
              );
            },
          );
        },
      ),
    );
  }
}
