/// Dart mirrors of the Chronicle API shapes (see src/types.ts and
/// server/routes/manuscripts.ts). Metadata is kept as a raw map so every field
/// (synopsis, contactName, cover, …) round-trips through PUT untouched, even
/// the ones this client doesn't model yet.

class ManuscriptMeta {
  final String id;
  final String title;
  final String author;
  final int lastModified;

  ManuscriptMeta({
    required this.id,
    required this.title,
    required this.author,
    required this.lastModified,
  });

  factory ManuscriptMeta.fromJson(Map<String, dynamic> j) => ManuscriptMeta(
        id: j['id'] as String,
        title: (j['title'] ?? 'Untitled Manuscript') as String,
        author: (j['author'] ?? '') as String,
        lastModified: (j['lastModified'] ?? 0) as int,
      );
}

class Chapter {
  final String id;
  String title;
  String content;
  int lastModified;

  Chapter({
    required this.id,
    required this.title,
    required this.content,
    required this.lastModified,
  });

  factory Chapter.fromJson(Map<String, dynamic> j) => Chapter(
        id: j['id'] as String,
        title: (j['title'] ?? '') as String,
        content: (j['content'] ?? '') as String,
        lastModified: (j['lastModified'] ?? 0) as int,
      );

  Map<String, dynamic> toJson() => {
        'id': id,
        'title': title,
        'content': content,
        'lastModified': lastModified,
      };
}

class Manuscript {
  /// Full metadata map, preserved verbatim for round-tripping.
  final Map<String, dynamic> metadata;
  final List<Chapter> chapters;

  Manuscript({required this.metadata, required this.chapters});

  factory Manuscript.fromJson(Map<String, dynamic> j) => Manuscript(
        metadata: Map<String, dynamic>.from(j['metadata'] as Map),
        chapters: ((j['chapters'] ?? const []) as List)
            .map((c) => Chapter.fromJson(Map<String, dynamic>.from(c as Map)))
            .toList(),
      );

  Map<String, dynamic> toJson() => {
        'metadata': metadata,
        'chapters': chapters.map((c) => c.toJson()).toList(),
      };

  String get id => metadata['id'] as String;
  String get title => (metadata['title'] ?? 'Untitled Manuscript') as String;
}
